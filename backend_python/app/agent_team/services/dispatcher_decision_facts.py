"""Port of backend/src/AgentTeam/Services/DispatcherDecisionFacts.php.

What a compiled dispatcher bakes for decision-model routing, read once at compile time: its routing mode,
floor, unclear branch, the question a decision model answers, and the decision providers it may call.
Same rules as GraphWorkflowRunner: the saved agent record's name, description and settings when the node
references one, else the node's own.
"""
from __future__ import annotations

from app.agent_team.services.compiler_php import json_decode_assoc
from app.agent_team.services.dispatch_routing import DispatchRouting
from app.agent_team.services.jev_router import JevRouter
from app.services.decision_providers import DecisionProviders
from app.support.phpcompat import is_numeric, php_floatval, php_intval, php_strval, php_trim


def _first(*values):
    for v in values:
        if v is not None:
            return v
    return None


def _elvis(v: str, alt):
    return alt if v in ('', '0') else v


class DispatcherDecisionFacts:
    @classmethod
    def of(cls, db, agentRepo, node: dict, wfName: str) -> dict:
        """{decision_question, routing_mode, unclear_branch, min_confidence, decision: [candidates]}."""
        cfg = node.get('config') if isinstance(node.get('config'), dict) else {}
        name = php_strval(_first(cfg.get('agent_name'), cfg.get('name'), node.get('name'), ''))
        desc = php_strval(_first(cfg.get('description'), ''))
        settings = cfg.get('settings') if isinstance(cfg.get('settings'), dict) else {}
        agentId = _first(node.get('agent_id'), cfg.get('agent_id'))
        if agentRepo is not None and agentId is not None and agentId != '':
            try:
                agent = agentRepo.findById(php_intval(agentId))
            except Exception:  # noqa: BLE001
                agent = None
            if agent is not None:
                a = agent.toArray()
                if php_trim(php_strval(_first(a.get('name'), ''))) != '':
                    name = php_strval(a['name'])
                if php_trim(php_strval(_first(a.get('description'), ''))) != '':
                    desc = php_strval(a['description'])
                rec = _first(a.get('settings'), [])
                rec = json_decode_assoc(rec) if isinstance(rec, str) else rec
                settings = rec if isinstance(rec, dict) else {}
        mode = php_trim(php_strval(_first(settings.get('routing_mode'), '')))
        floor = _first(settings.get('min_confidence'), settings.get('jev_min_confidence'))
        return {
            'decision_question': DispatchRouting.defaultInstructions(name, desc, wfName),
            'routing_mode': mode,
            'unclear_branch': php_trim(php_strval(_first(settings.get('unclear_branch'), ''))),
            'min_confidence': (max(0.0, min(1.0, php_floatval(floor))) if floor is not None and is_numeric(floor)
                               else JevRouter.DEFAULT_CONFIDENCE_FLOOR),
            'decision': [] if db is None else cls._candidates(db, mode),
        }

    @staticmethod
    def _candidates(db, mode: str) -> list:
        """The named provider row, every usable row (admin order) for an unset mode, none for 'llm'."""
        if mode == 'llm':
            return []
        out = []
        try:
            rows = DecisionProviders.rows(db)
        except Exception:  # noqa: BLE001 -- no decision provider table: nothing to route with
            return []
        for row in rows:
            key = php_strval(row['provider_key'])
            protocol = DecisionProviders.protocolOf(row)
            if protocol is None or (mode != '' and key != mode):
                continue
            stem = DecisionProviders.envStem(key)
            out.append({
                'provider': key,
                'protocol': php_strval(row['protocol']),
                'url': _elvis(php_trim(php_strval(_first(row.get('base_url'), ''))), protocol['url']),
                'model': _elvis(php_trim(php_strval(_first(row.get('model'), ''))), protocol['model']),
                'key_env': stem + '_API_KEY',
                'url_env': stem + '_BASE_URL',
            })
        return out
