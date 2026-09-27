"""File storage for uploads (local disk under UPLOAD_DIR; object storage later). Returns a relative path."""
import secrets
from pathlib import Path

from flask import current_app
from werkzeug.datastructures import FileStorage
from werkzeug.utils import secure_filename

from services.errors import ValidationError


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
