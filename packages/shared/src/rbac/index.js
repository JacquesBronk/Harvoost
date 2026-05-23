"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ROLES = exports.KAnonymityError = exports.enforceKAnonymity = exports.RbacForbiddenError = exports.RbacError = exports.RbacScopeService = void 0;
var RbacScopeService_js_1 = require("./RbacScopeService.js");
Object.defineProperty(exports, "RbacScopeService", { enumerable: true, get: function () { return RbacScopeService_js_1.RbacScopeService; } });
var errors_js_1 = require("./errors.js");
Object.defineProperty(exports, "RbacError", { enumerable: true, get: function () { return errors_js_1.RbacError; } });
Object.defineProperty(exports, "RbacForbiddenError", { enumerable: true, get: function () { return errors_js_1.RbacForbiddenError; } });
var k_anonymity_js_1 = require("./k-anonymity.js");
Object.defineProperty(exports, "enforceKAnonymity", { enumerable: true, get: function () { return k_anonymity_js_1.enforceKAnonymity; } });
Object.defineProperty(exports, "KAnonymityError", { enumerable: true, get: function () { return k_anonymity_js_1.KAnonymityError; } });
var types_js_1 = require("./types.js");
Object.defineProperty(exports, "ROLES", { enumerable: true, get: function () { return types_js_1.ROLES; } });
//# sourceMappingURL=index.js.map