"""The shared SQLAlchemy object. Models and repositories import `db` from here, never from app.py.

The schema is owned by the SQL files in db/ — never call db.create_all().
"""
from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()
