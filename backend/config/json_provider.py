"""JSON encoding: ISO 8601 dates, money as strings, enums as their values."""
import enum
from datetime import date, datetime, time
from decimal import Decimal
from uuid import UUID

from flask.json.provider import DefaultJSONProvider

TWO_PLACES = Decimal("0.01")


class JSONProvider(DefaultJSONProvider):
    sort_keys = False

    @staticmethod
    def default(o):
        if isinstance(o, (datetime, date, time)):
            return o.isoformat()
        if isinstance(o, Decimal):
            return str(o.quantize(TWO_PLACES)) if o.is_finite() else str(o)  # money: always "27000.00"
        if isinstance(o, enum.Enum):
            return o.value
        if isinstance(o, UUID):
            return str(o)
        return DefaultJSONProvider.default(o)
