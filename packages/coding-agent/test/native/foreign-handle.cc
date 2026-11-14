#include <node_api.h>
#include <stdint.h>

static napi_value makeForeignExternal(napi_env env, napi_callback_info) {
	napi_value external;
	if (napi_create_external(env, reinterpret_cast<void*>(static_cast<uintptr_t>(1)), nullptr, nullptr, &external) != napi_ok) {
		return nullptr;
	}
	return external;
}

static napi_value initialize(napi_env env, napi_value exports) {
	napi_property_descriptor property = {"make", nullptr, makeForeignExternal, nullptr, nullptr, nullptr, napi_default, nullptr};
	if (napi_define_properties(env, exports, 1, &property) != napi_ok) return nullptr;
	return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
