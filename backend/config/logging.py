"""Application logging."""
import logging


def configure_logging(level: str) -> None:
    logging.basicConfig(
        level=level.upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        force=True,
    )
    for noisy in ("botocore", "boto3", "s3transfer", "urllib3"):  # their DEBUG output is one line per HTTP detail
        logging.getLogger(noisy).setLevel(logging.WARNING)
