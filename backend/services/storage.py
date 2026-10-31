"""File storage for uploads (local disk under UPLOAD_DIR; object storage later). Returns a relative path."""
import logging
import secrets
from pathlib import Path

from flask import current_app
from werkzeug.datastructures import FileStorage
from werkzeug.utils import secure_filename

from services.errors import StorageUnavailable, ValidationError

log = logging.getLogger(__name__)


def save_upload(upload: FileStorage, folder: str, field: str = "file") -> dict:
    """Save the file under UPLOAD_DIR/folder with a random prefix. Returns path, name, type and size."""
    name = secure_filename(upload.filename or "")
    extension = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if extension not in current_app.config["ALLOWED_UPLOAD_EXTENSIONS"]:
        allowed = ", ".join(sorted(current_app.config["ALLOWED_UPLOAD_EXTENSIONS"]))
        raise ValidationError("File type not allowed", {field: [f"Allowed: {allowed}"]})
    content = upload.read()
    if not content:
        raise ValidationError("The file is empty", {field: ["Empty file"]})

    relative = Path(folder) / f"{secrets.token_hex(8)}-{name}"
    target = Path(current_app.config["UPLOAD_DIR"]) / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)
    return {"file_path": str(relative), "original_filename": upload.filename, "mime_type": upload.mimetype,
            "file_size_bytes": len(content)}


def delete_file(relative_path: str) -> None:
    target = Path(current_app.config["UPLOAD_DIR"]) / relative_path
    if target.is_file():
        target.unlink()


def _s3_client():
    import boto3  # imported here so the app starts without boto3 when no bucket is configured

    cfg = current_app.config
    keys = {"aws_access_key_id": cfg["AWS_ACCESS_KEY"], "aws_secret_access_key": cfg["AWS_SECRET_KEY"]} if cfg["AWS_ACCESS_KEY"] and cfg["AWS_SECRET_KEY"] else {}
    return boto3.client("s3", region_name=cfg["AWS_REGION"], **keys)


def save_import_file(key: str, content: bytes, content_type: str = "text/csv") -> str:
    """Keep an uploaded import file. S3 (S3_IMPORT_BUCKET, private, encrypted) when configured, else UPLOAD_DIR.

    Returns the stored location: `s3://bucket/key`, or the relative local path. Raises if S3 refuses, so a file
    that could not be kept is never imported.
    """
    bucket = current_app.config.get("S3_IMPORT_BUCKET")
    if not bucket:
        target = Path(current_app.config["UPLOAD_DIR"]) / key
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        return key
    try:
        _s3_client().put_object(Bucket=bucket, Key=key, Body=content, ContentType=content_type, ServerSideEncryption="AES256")
    except Exception as exc:  # boto raises many types (ClientError, BotoCoreError, NoCredentialsError)
        log.exception("S3 upload failed for %s", key)
        raise StorageUnavailable("The file could not be stored. Try again, or ask an admin to check the S3 settings.") from exc
    return f"s3://{bucket}/{key}"
