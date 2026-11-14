#include <node_api.h>
#include <errno.h>
#include <fcntl.h>
#include <new>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

struct Lease {
	int fd;
};

static const napi_type_tag leaseTag = {0x7cf431e0c3d249adULL, 0xb4906fdc2a61e037ULL};

static int closeLease(Lease* lease) {
	if (!lease || lease->fd < 0) return 0;
	int fd = lease->fd;
	lease->fd = -1;
	// On Linux, close() must not be retried after EINTR: the descriptor is closed.
	if (close(fd) < 0) return errno;
	return 0;
}

static void finalizeLease(napi_env, void* data, void*) {
	Lease* lease = static_cast<Lease*>(data);
	closeLease(lease);
	delete lease;
}

static napi_value throwError(napi_env env, const char* message) {
	napi_throw_error(env, nullptr, message);
	return nullptr;
}

static bool getLease(napi_env env, napi_value value, Lease** result) {
	napi_valuetype type;
	if (napi_typeof(env, value, &type) != napi_ok || type != napi_object) return false;
	bool tagged = false;
	if (napi_check_object_type_tag(env, value, &leaseTag, &tagged) != napi_ok || !tagged) return false;
	void* data = nullptr;
	if (napi_unwrap(env, value, &data) != napi_ok || !data) return false;
	*result = static_cast<Lease*>(data);
	return true;
}

static napi_value acquire(napi_env env, napi_callback_info info) {
	size_t argc = 2;
	napi_value argv[2];
	if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
		return throwError(env, "acquire(path) requires exactly one absolute lock path");
	}
	napi_valuetype type;
	if (napi_typeof(env, argv[0], &type) != napi_ok || type != napi_string) {
		return throwError(env, "lock path must be a string");
	}
	size_t length = 0;
	if (napi_get_value_string_utf8(env, argv[0], nullptr, 0, &length) != napi_ok || length == 0 || length > 4095) {
		return throwError(env, "lock path has invalid length");
	}
	char* path = new (std::nothrow) char[length + 1];
	if (!path) return throwError(env, "out of memory");
	size_t written = 0;
	if (napi_get_value_string_utf8(env, argv[0], path, length + 1, &written) != napi_ok || written != length || path[0] != '/') {
		delete[] path;
		return throwError(env, "lock path must be an absolute path");
	}
	if (memchr(path, '\0', length) != nullptr) {
		delete[] path;
		return throwError(env, "lock path contains NUL");
	}
	int fd;
	do { fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW); } while (fd < 0 && errno == EINTR);
	delete[] path;
	if (fd < 0) {
		char error[256];
		snprintf(error, sizeof(error), "open lock path: %s", strerror(errno));
		return throwError(env, error);
	}
	struct stat metadata;
	if (fstat(fd, &metadata) < 0) {
		int saved = errno;
		close(fd);
		char error[256];
		snprintf(error, sizeof(error), "fstat lock path: %s", strerror(saved));
		return throwError(env, error);
	}
	if (!S_ISREG(metadata.st_mode) || metadata.st_nlink != 1) {
		close(fd);
		return throwError(env, "lock path must be a single-link regular file");
	}
	int result;
	do { result = flock(fd, LOCK_SH); } while (result < 0 && errno == EINTR);
	if (result < 0) {
		int saved = errno;
		close(fd);
		char error[256];
		snprintf(error, sizeof(error), "flock shared lock: %s", strerror(saved));
		return throwError(env, error);
	}
	Lease* lease = new (std::nothrow) Lease{fd};
	if (!lease) {
		close(fd);
		return throwError(env, "out of memory");
	}
	napi_value handle;
	if (napi_create_object(env, &handle) != napi_ok || napi_type_tag_object(env, handle, &leaseTag) != napi_ok) {
		finalizeLease(env, lease, nullptr);
		return throwError(env, "could not create lease handle");
	}
	if (napi_wrap(env, handle, lease, finalizeLease, nullptr, nullptr) != napi_ok) {
		finalizeLease(env, lease, nullptr);
		return throwError(env, "could not wrap lease handle");
	}
	return handle;
}

static napi_value release(napi_env env, napi_callback_info info) {
	size_t argc = 2;
	napi_value argv[2];
	if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
		return throwError(env, "release(handle) requires exactly one lease handle");
	}
	Lease* lease = nullptr;
	if (!getLease(env, argv[0], &lease)) return throwError(env, "invalid lease handle");
	int error = closeLease(lease);
	if (error != 0) {
		char message[256];
		snprintf(message, sizeof(message), "close lease descriptor: %s", strerror(error));
		return throwError(env, message);
	}
	return nullptr;
}

// Test-only primitive to verify Linux fork inheritance without an intervening exec.
static napi_value forkLeaseForTest(napi_env env, napi_callback_info info) {
	size_t argc = 2;
	napi_value argv[2];
	if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
		return throwError(env, "forkLeaseForTest(handle) requires exactly one lease handle");
	}
	Lease* lease = nullptr;
	if (!getLease(env, argv[0], &lease) || lease->fd < 0) return throwError(env, "invalid active lease handle");
	pid_t pid = fork();
	if (pid < 0) return throwError(env, "fork failed");
	if (pid == 0) {
		for (;;) pause();
	}
	napi_value result;
	if (napi_create_int32(env, static_cast<int32_t>(pid), &result) != napi_ok) {
		kill(pid, SIGKILL);
		waitpid(pid, nullptr, 0);
		return throwError(env, "could not return fork child pid");
	}
	return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
	napi_property_descriptor properties[] = {
		{"acquire", nullptr, acquire, nullptr, nullptr, nullptr, napi_default, nullptr},
		{"release", nullptr, release, nullptr, nullptr, nullptr, napi_default, nullptr},
		{"forkLeaseForTest", nullptr, forkLeaseForTest, nullptr, nullptr, nullptr, napi_default, nullptr},
	};
	if (napi_define_properties(env, exports, 3, properties) != napi_ok) return nullptr;
	return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
