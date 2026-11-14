#include <node_api.h>
#include <errno.h>
#include <fcntl.h>
#include <new>
#include <stdio.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

struct Lease {
	int fd;
};

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

static napi_value acquire(napi_env env, napi_callback_info info) {
	size_t argc = 1;
	napi_value argv[1];
	if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
		return throwError(env, "acquire(path) requires one absolute lock path");
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
	do { fd = open(path, O_RDONLY | O_CLOEXEC); } while (fd < 0 && errno == EINTR);
	delete[] path;
	if (fd < 0) {
		char error[256];
		snprintf(error, sizeof(error), "open lock path: %s", strerror(errno));
		return throwError(env, error);
	}
	struct stat metadata;
	if (fstat(fd, &metadata) < 0 || !S_ISREG(metadata.st_mode)) {
		int saved = errno;
		if (saved == 0) saved = EINVAL;
		close(fd);
		char error[256];
		snprintf(error, sizeof(error), "lock path must be a regular file: %s", strerror(saved));
		return throwError(env, error);
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
	napi_value external;
	if (napi_create_external(env, lease, finalizeLease, nullptr, &external) != napi_ok) {
		finalizeLease(env, lease, nullptr);
		return throwError(env, "could not create lease handle");
	}
	return external;
}

static napi_value release(napi_env env, napi_callback_info info) {
	size_t argc = 1;
	napi_value argv[1];
	if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
		return throwError(env, "release(handle) requires one lease handle");
	}
	napi_valuetype type;
	if (napi_typeof(env, argv[0], &type) != napi_ok || type != napi_external) {
		return throwError(env, "invalid lease handle");
	}
	Lease* lease = nullptr;
	if (napi_get_value_external(env, argv[0], reinterpret_cast<void**>(&lease)) != napi_ok || !lease) {
		return throwError(env, "invalid lease handle");
	}
	int error = closeLease(lease);
	if (error != 0) {
		char message[256];
		snprintf(message, sizeof(message), "close lease descriptor: %s", strerror(error));
		return throwError(env, message);
	}
	return nullptr;
}

static napi_value initialize(napi_env env, napi_value exports) {
	napi_property_descriptor properties[] = {
		{"acquire", nullptr, acquire, nullptr, nullptr, nullptr, napi_default, nullptr},
		{"release", nullptr, release, nullptr, nullptr, nullptr, napi_default, nullptr},
	};
	if (napi_define_properties(env, exports, 2, properties) != napi_ok) return nullptr;
	return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
