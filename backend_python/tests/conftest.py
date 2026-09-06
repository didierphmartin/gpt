import os
import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope='session')
def config():
    from app.config import load_config
    return load_config()


@pytest.fixture(scope='session')
def client(config):
    from main import create_app
    return TestClient(create_app(config))
