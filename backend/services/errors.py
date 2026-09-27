"""Errors raised by services (and controllers). Each maps to an HTTP status + code in controllers/common.py."""


class AppError(Exception):
    status = 400
    code = "BAD_REQUEST"

    def __init__(self, message: str, details=None):
        super().__init__(message)
        self.message = message
        self.details = details


class ValidationError(AppError):
    status = 400
    code = "VALIDATION_ERROR"


class Unauthenticated(AppError):
    status = 401
    code = "UNAUTHENTICATED"


class FreshAuthRequired(AppError):
    status = 401
    code = "FRESH_AUTH_REQUIRED"


class Forbidden(AppError):
    status = 403
    code = "FORBIDDEN"


class PasswordChangeRequired(AppError):
    status = 403
    code = "PASSWORD_CHANGE_REQUIRED"


class NotFound(AppError):
    status = 404
    code = "NOT_FOUND"


class Conflict(AppError):
    status = 409
    code = "CONFLICT"


class BusinessRule(AppError):
    status = 422
    code = "BUSINESS_RULE"


class TooManyAttempts(AppError):
    status = 429
    code = "TOO_MANY_ATTEMPTS"
