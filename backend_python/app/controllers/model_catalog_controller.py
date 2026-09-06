"""Port of Controllers/ModelCatalogController.php (public; reads resources/model_catalog.json)."""
import json
from pathlib import Path

CATALOG_PATH = Path(__file__).resolve().parent.parent.parent / 'resources' / 'model_catalog.json'


class ModelCatalogController:
    def __init__(self, db, config):
        pass

    def get(self, request):
        if not CATALOG_PATH.is_file():
            return {'success': False, 'error': 'Model catalog file not found', 'status_code': 500}
        try:
            raw = CATALOG_PATH.read_text(encoding='utf-8')
        except OSError:
            return {'success': False, 'error': 'Failed to read model catalog', 'status_code': 500}
        try:
            data = json.loads(raw)
        except ValueError:
            data = None
        if not isinstance(data, dict) or not isinstance(data.get('providers'), (dict, list)):
            return {'success': False, 'error': 'Model catalog is malformed', 'status_code': 500}
        return {'success': True, 'providers': data['providers'], 'updated': data.get('_updated')}
