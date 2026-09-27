"""Shared controller helpers: JSON responses, request validation, pagination params, error responses.

Success:  {"data": ...}  (+ "meta" for lists)
Error:    {"error": {"code": ..., "message": ..., "details": ...}}
"""
import logging
import re
from datetime import date, datetime, time
from decimal import Decimal, InvalidOperation
from typing import Any, Callable

from flask import current_app, jsonify, request
from sqlalchemy.exc import DBAPIError
from werkzeug.exceptions import HTTPException

from services.errors import AppError, ValidationError
from services.persons import normalise_phone

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------- responses

def ok(data: Any = None, status: int = 200, meta: dict | None = None):
    body: dict[str, Any] = {"data": data}
    if meta is not None:
        body["meta"] = meta
    return jsonify(body), status


def created(data: Any = None):
    return ok(data, status=201)


def no_content():
    return "", 204


def paginated(items: list, meta: dict):
    return ok(items, meta=meta)


def error_response(code: str, message: str, status: int, details: Any = None):
    body: dict[str, Any] = {"code": code, "message": message}
    if details is not None:
        body["details"] = details
    return jsonify({"error": body}), status


# ---------------------------------------------------------------- request input

def json_body() -> dict:
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


_MISSING = object()
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class Validator:
    """Validate a dict field by field; validate() returns the cleaned data or raises ValidationError.

    Only fields present in the input end up in the result (unless a default is given),
    so the same rules work for create and partial update.

        v = Validator(json_body())
        v.email("email", required=True)
        v.string("full_name", required=True, max_length=150)
        data = v.validate()
    """

    def __init__(self, data: Any):
        self.data = data if isinstance(data, dict) else {}
        self.errors: dict[str, Any] = {}
        self.cleaned: dict[str, Any] = {}

    def _error(self, field: str, message: str) -> None:
        self.errors[field] = [message]

    def _value(self, field: str, required: bool, nullable: bool, default: Any) -> Any:
        if field not in self.data:
            if required:
                self._error(field, "Required")
            elif default is not _MISSING:
                self.cleaned[field] = default
            return _MISSING
        value = self.data[field]
        if value is None:
            if required:
                self._error(field, "Required")
            elif nullable:
                self.cleaned[field] = None
            else:
                self._error(field, "Can't be empty")
            return _MISSING
        return value

    def string(self, field: str, *, required=False, nullable=False, default=_MISSING,
               min_length: int | None = None, max_length: int | None = None, strip=True, lower=False,
               upper=False, pattern: str | None = None, pattern_message: str = "Invalid format") -> None:
        value = self._value(field, required, nullable, default)
        if value is _MISSING:
            return
        if not isinstance(value, str):
            return self._error(field, "Must be text")
        if strip:
            value = value.strip()
        if lower:
            value = value.lower()
        if upper:
            value = value.upper()
        if required and not value:
            return self._error(field, "Required")
        if min_length is not None and len(value) < min_length:
            return self._error(field, f"Must be at least {min_length} characters")
        if max_length is not None and len(value) > max_length:
            return self._error(field, f"Must be at most {max_length} characters")
        if pattern is not None and value and not re.fullmatch(pattern, value):
            return self._error(field, pattern_message)
        self.cleaned[field] = value

    def email(self, field: str, *, required=False, nullable=False, default=_MISSING) -> None:
        self.string(field, required=required, nullable=nullable, default=default, max_length=255, lower=True)
        value = self.cleaned.get(field)
        if value and not _EMAIL.match(value):
            self.cleaned.pop(field)
            self._error(field, "Not a valid email address")

    def integer(self, field: str, *, required=False, nullable=False, default=_MISSING, min_value: int | None = None,
                max_value: int | None = None) -> None:
        value = self._value(field, required, nullable, default)
        if value is _MISSING:
            return
        if isinstance(value, str) and value.strip().lstrip("-").isdigit():
            value = int(value)
        if not isinstance(value, int) or isinstance(value, bool):
            return self._error(field, "Must be a whole number")
        if min_value is not None and value < min_value:
            return self._error(field, f"Must be {min_value} or more")
        if max_value is not None and value > max_value:
            return self._error(field, f"Must be {max_value} or less")
        self.cleaned[field] = value

    def boolean(self, field: str, *, required=False, default=_MISSING) -> None:
        value = self._value(field, required, False, default)
        if value is _MISSING:
            return
        if isinstance(value, str) and value.lower() in ("true", "false", "1", "0"):
            value = value.lower() in ("true", "1")
        if not isinstance(value, bool):
            return self._error(field, "Must be true or false")
        self.cleaned[field] = value

    def datetime(self, field: str, *, required=False, nullable=False, default=_MISSING) -> None:
        """ISO 8601 with a timezone, e.g. 2026-10-01T09:00:00+05:30."""
        value = self._value(field, required, nullable, default)
        if value is _MISSING:
            return
        try:
            parsed = datetime.fromisoformat(value) if isinstance(value, str) else None
        except ValueError:
            parsed = None
        if parsed is None:
            return self._error(field, "Must be an ISO 8601 date-time")
        if parsed.tzinfo is None:
            return self._error(field, "Must include a timezone offset")
        self.cleaned[field] = parsed

    def choice(self, field: str, options: tuple[str, ...], *, required=False, nullable=False, default=_MISSING) -> None:
        value = self._value(field, required, nullable, default)
        if value is _MISSING:
            return
        if value not in options:
            return self._error(field, f"Must be one of: {', '.join(options)}")
        self.cleaned[field] = value

    def decimal(self, field: str, *, required=False, nullable=False, default=_MISSING,
                min_value: Decimal | int | None = None, max_value: Decimal | int | None = None) -> None:
        """Money / percentages: number or numeric string, rounded to 2 decimals."""
        value = self._value(field, required, nullable, default)
        if value is _MISSING:
            return
        if isinstance(value, bool):
            return self._error(field, "Must be a number")
        try:
            number = Decimal(str(value)).quantize(Decimal("0.01"))
        except (InvalidOperation, ValueError):
            return self._error(field, "Must be a number")
        if not number.is_finite():
            return self._error(field, "Must be a number")
        if min_value is not None and number < min_value:
            return self._error(field, f"Must be {min_value} or more")
        if max_value is not None and number > max_value:
            return self._error(field, f"Must be {max_value} or less")
        self.cleaned[field] = number

    def date(self, field: str, *, required=False, nullable=False, default=_MISSING) -> None:
        """YYYY-MM-DD."""
        value = self._value(field, required, nullable, default)
        if value is _MISSING:
            return
        try:
            self.cleaned[field] = date.fromisoformat(value) if isinstance(value, str) else None
        except ValueError:
            pass
        if self.cleaned.get(field) is None:
            self.cleaned.pop(field, None)
            self._error(field, "Must be a date (YYYY-MM-DD)")

    def time(self, field: str, *, required=False) -> None:
        """HH:MM (24-hour)."""
        value = self._value(field, required, False, _MISSING)
        if value is _MISSING:
            return
        try:
            self.cleaned[field] = time.fromisoformat(value) if isinstance(value, str) and len(value) == 5 else None
        except ValueError:
            pass
        if self.cleaned.get(field) is None:
            self.cleaned.pop(field, None)
            self._error(field, "Must be a time (HH:MM)")

    def phone(self, field: str, *, required=False, nullable=False, default=_MISSING) -> None:
        """Indian mobile numbers are stored as +91XXXXXXXXXX; other numbers need a leading +country code."""
        self.string(field, required=required, nullable=nullable, default=default, max_length=20)
        value = self.cleaned.get(field)
        if not value:
            return
        normalised = normalise_phone(value)
        if normalised is None:
            self.cleaned.pop(field)
            return self._error(field, "Not a valid phone number")
        self.cleaned[field] = normalised

    def id_list(self, field: str, *, required=False, min_items=0) -> None:
        """A list of positive whole numbers (duplicates removed, order kept)."""
        value = self._value(field, required, False, _MISSING)
        if value is _MISSING:
            return
        if not isinstance(value, list) or not all(isinstance(i, int) and not isinstance(i, bool) and i > 0 for i in value):
            return self._error(field, "Must be a list of IDs")
        if len(value) < min_items:
            return self._error(field, f"Add at least {min_items}")
        self.cleaned[field] = list(dict.fromkeys(value))

    def int_list(self, field: str, *, required=False, nullable=False, min_value: int | None = None) -> None:
        """A list of whole numbers, order and duplicates kept (e.g. agreed due days per instalment)."""
        value = self._value(field, required, nullable, _MISSING)
        if value is _MISSING:
            return
        if not isinstance(value, list) or not all(isinstance(i, int) and not isinstance(i, bool) for i in value):
            return self._error(field, "Must be a list of whole numbers")
        if min_value is not None and any(i < min_value for i in value):
            return self._error(field, f"Every value must be {min_value} or more")
        self.cleaned[field] = value

    def nested(self, field: str, rules: Callable[["Validator"], None], *, required=False, nullable=False) -> None:
        """A dict value validated by rules(Validator(value)); errors are nested under the field."""
        value = self._value(field, required, nullable, _MISSING)
        if value is _MISSING:
            return
        if not isinstance(value, dict):
            return self._error(field, "Must be an object")
        inner = Validator(value)
        rules(inner)
        if inner.errors:
            self.errors[field] = inner.errors
        else:
            self.cleaned[field] = inner.cleaned

    def list_of(self, field: str, validate_item: Callable[["Validator"], None], *, required=False, min_items=0) -> None:
        """Each item is a dict validated by validate_item(Validator(item))."""
        value = self._value(field, required, False, _MISSING)
        if value is _MISSING:
            return
        if not isinstance(value, list):
            return self._error(field, "Must be a list")
        if len(value) < min_items:
            return self._error(field, f"Add at least {min_items}")
        items, item_errors = [], {}
        for index, item in enumerate(value):
            item_validator = Validator(item)
            validate_item(item_validator)
            if item_validator.errors:
                item_errors[str(index)] = item_validator.errors
            else:
                items.append(item_validator.cleaned)
        if item_errors:
            self.errors[field] = item_errors
        else:
            self.cleaned[field] = items

    def validate(self) -> dict:
        if self.errors:
            raise ValidationError("Invalid request data", self.errors)
        return self.cleaned


def require_changes(data: dict) -> dict:
    """PATCH bodies: reject an empty update."""
    if not data:
        raise ValidationError("Provide at least one field to update")
    return data


def get_page_params() -> tuple[int, int]:
    """?page= (default 1) and ?per_page= (default 25, max 100)."""
    max_per_page = current_app.config["PER_PAGE_MAX"]
    v = Validator({"page": request.args.get("page", "1"),
                   "per_page": request.args.get("per_page", str(current_app.config["PER_PAGE_DEFAULT"]))})
    v.integer("page", min_value=1)
    v.integer("per_page", min_value=1)
    if v.cleaned.get("per_page", 0) > max_per_page:
        v.cleaned.pop("per_page")
        v._error("per_page", f"Must be at most {max_per_page}")
    if v.errors:
        raise ValidationError("Invalid pagination parameters", v.errors)
    return v.cleaned["page"], v.cleaned["per_page"]


# ---------------------------------------------------------------- exceptions -> responses

# Postgres SQLSTATE -> (status, code). Triggers raise readable business-rule messages,
# so they are passed straight through.
PG_ERRORS = {
    "P0001": (422, "BUSINESS_RULE"),      # RAISE EXCEPTION in a trigger / function
    "23514": (422, "BUSINESS_RULE"),      # check constraint
    "23P01": (422, "BUSINESS_RULE"),      # exclusion constraint
    "23502": (422, "BUSINESS_RULE"),      # not null
    "23503": (422, "INVALID_REFERENCE"),  # foreign key
    "23505": (409, "CONFLICT"),           # unique
    "22P02": (400, "VALIDATION_ERROR"),   # invalid text representation (e.g., bad enum value)
}


def error_response_for(exc: Exception):
    if isinstance(exc, AppError):
        return error_response(exc.code, exc.message, exc.status, exc.details)

    if isinstance(exc, HTTPException):
        code = (exc.name or "HTTP_ERROR").upper().replace(" ", "_")
        return error_response(code, exc.description or exc.name, exc.code or 500)

    if isinstance(exc, DBAPIError):
        orig = exc.orig
        sqlstate = getattr(orig, "sqlstate", None)
        if sqlstate in PG_ERRORS:
            status, code = PG_ERRORS[sqlstate]
            diag = getattr(orig, "diag", None)
            message = (diag.message_primary if diag else None) or str(orig)
            details = {}
            if diag and diag.constraint_name:
                details["constraint"] = diag.constraint_name
            if diag and diag.message_detail:
                details["detail"] = diag.message_detail
            return error_response(code, message, status, details or None)

    logger.exception("Unhandled error", exc_info=exc)
    return error_response("INTERNAL_ERROR", "Something went wrong", 500)
