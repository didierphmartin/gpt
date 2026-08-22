<?php

declare(strict_types=1);

namespace Quantis\AIPortfolioAssistant\Controllers;

use PDO;

/**
 * Video Editor admin controller.
 *
 * Reads the dedicated video-edit usage DB (netfo587_video_editor) for the
 * gpt_admin "Video Editor" pages: per-generation cost/usage and prices. User
 * names are resolved from the login DB since usage.user_id is the login user id
 * (the JWT `sub`). DB credentials come from gpt-backend's own config
 * ($config['video_editor_database'] / ['login_database'], sourced from .env) —
 * no hardcoded paths or URLs, so this travels unchanged to production.
 */
class VideoEditorController
{
    /** App identifier stored in login.app_user_roles.app (must match video-edit's VE_APP). */
    private const APP = 'video-edit';

    private array $config;
    private PDO $db;

    public function __construct(PDO $db, array $config)
    {
        $this->config = $config;
        $this->db = $db; // chatbot DB — used only to verify the caller's admin role
    }

    /** Gate an endpoint to admins. Returns an error array to short-circuit, or
     *  null to proceed. Mirrors PackageController::requireAdmin. */
    private function requireAdmin(array $request): ?array
    {
        $userId = $request['user_id'] ?? null;
        if (!$userId) return ['success' => false, 'error' => 'Authentication required', 'status_code' => 401];
        $stmt = $this->db->prepare('SELECT role FROM users WHERE id = :id LIMIT 1');
        $stmt->execute([':id' => $userId]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$user || ($user['role'] ?? '') !== 'admin') {
            return ['success' => false, 'error' => 'Admin access required', 'status_code' => 403];
        }
        return null;
    }

    /** Open a PDO from a named config block, or null if unconfigured/unreachable. */
    private function connect(string $key): ?PDO
    {
        static $cache = [];
        if (array_key_exists($key, $cache)) return $cache[$key];
        $c = $this->config[$key] ?? null;
        if (!is_array($c) || empty($c['username']) || empty($c['database'])) return $cache[$key] = null;
        try {
            return $cache[$key] = new PDO(
                "mysql:host={$c['host']};dbname={$c['database']};charset=" . ($c['charset'] ?? 'utf8mb4'),
                (string)$c['username'], (string)$c['password'],
                [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC, PDO::ATTR_TIMEOUT => 6]
            );
        } catch (\Throwable $e) {
            error_log("[video-editor] DB '$key' connect failed: " . $e->getMessage());
            return $cache[$key] = null;
        }
    }

    private function ve(): ?PDO { return $this->connect('video_editor_database'); }
    private function login(): ?PDO { return $this->connect('login_database'); }

    /** registered_apps.id for the video-edit app — roles live in the CENTRALIZED
     *  login.app_user_roles keyed by this id. Cached; null if not registered. */
    private function veAppId(): ?int
    {
        static $id = false;
        if ($id !== false) return $id === null ? null : (int)$id;
        $login = $this->login();
        if (!$login) { $id = null; return null; }
        try {
            $s = $login->prepare("SELECT id FROM registered_apps WHERE app_id = ? LIMIT 1");
            $s->execute([self::APP]);
            $r = $s->fetchColumn();
            $id = $r !== false ? (int)$r : null;
        } catch (\Throwable $e) { $id = null; }
        return $id;
    }

    /** Resolve [user_id => ['email'=>,'name'=>]] from the login users table. */
    private function usersById(array $ids): array
    {
        $ids = array_values(array_unique(array_filter(array_map('intval', $ids))));
        if (!$ids) return [];
        $login = $this->login();
        if (!$login) return [];
        $in = implode(',', array_fill(0, count($ids), '?'));
        $s = $login->prepare("SELECT id, email, first_name, last_name FROM users WHERE id IN ($in)");
        $s->execute($ids);
        $out = [];
        foreach ($s->fetchAll() as $r) {
            $name = trim(($r['first_name'] ?? '') . ' ' . ($r['last_name'] ?? ''));
            $out[(int)$r['id']] = ['email' => $r['email'] ?? '', 'name' => $name !== '' ? $name : ($r['email'] ?? '')];
        }
        return $out;
    }

    private function range(array $request): array
    {
        $days = max(1, min(365, (int)($request['query']['days'] ?? 30)));
        return [$days];
    }

    /** GET /api/v1/admin/video-editor/usage/stats?days=30 — totals, by model, daily trend. */
    public function getUsageStats(array $request): array
    {
        $ve = $this->ve();
        if (!$ve) return ['success' => false, 'available' => false, 'message' => 'Video-edit usage DB not reachable'];
        [$days] = $this->range($request);
        try {
            $totals = (function () use ($ve, $days) {
                $s = $ve->prepare("SELECT COUNT(*) generations, COALESCE(SUM(cost_usd),0) cost,
                    COALESCE(SUM(prompt_tokens),0) tokens_in, COALESCE(SUM(completion_tokens),0) tokens_out,
                    COUNT(DISTINCT user_id) users
                    FROM video_edit_usage WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)");
                $s->execute([$days]); return $s->fetch();
            })();
            $byModel = (function () use ($ve, $days) {
                $s = $ve->prepare("SELECT kind, model, COUNT(*) generations, COALESCE(SUM(units),0) units,
                    COALESCE(SUM(cost_usd),0) cost FROM video_edit_usage
                    WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) GROUP BY kind, model ORDER BY cost DESC");
                $s->execute([$days]); return $s->fetchAll();
            })();
            $daily = (function () use ($ve, $days) {
                $s = $ve->prepare("SELECT DATE(created_at) day, COUNT(*) generations, COALESCE(SUM(cost_usd),0) cost
                    FROM video_edit_usage WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
                    GROUP BY DATE(created_at) ORDER BY day ASC");
                $s->execute([$days]); return $s->fetchAll();
            })();
            return ['success' => true, 'available' => true, 'days' => $days,
                    'totals' => $totals, 'byModel' => $byModel, 'daily' => $daily];
        } catch (\Throwable $e) {
            return ['success' => false, 'available' => false, 'message' => 'Usage query failed'];
        }
    }

    /** GET /api/v1/admin/video-editor/usage/by-user?days=30 — per-user consumption + names. */
    public function getUsageByUser(array $request): array
    {
        $ve = $this->ve();
        if (!$ve) return ['success' => false, 'available' => false, 'users' => []];
        [$days] = $this->range($request);
        try {
            $s = $ve->prepare("SELECT user_id, COUNT(*) generations, COALESCE(SUM(cost_usd),0) cost,
                COALESCE(SUM(prompt_tokens),0) tokens_in, COALESCE(SUM(completion_tokens),0) tokens_out,
                MAX(created_at) last_used
                FROM video_edit_usage WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
                GROUP BY user_id ORDER BY cost DESC");
            $s->execute([$days]);
            $rows = $s->fetchAll();
            $names = $this->usersById(array_column($rows, 'user_id'));
            foreach ($rows as &$r) {
                $u = $names[(int)$r['user_id']] ?? null;
                $r['email'] = $u['email'] ?? null;
                $r['name'] = $u['name'] ?? null;
            }
            return ['success' => true, 'available' => true, 'days' => $days, 'users' => $rows];
        } catch (\Throwable $e) {
            return ['success' => false, 'available' => false, 'users' => []];
        }
    }

    /** GET /api/v1/admin/video-editor/transactions?user_id=&month=YYYY-MM&days=&all=1&page=&per_page=
     *  Row-level generation transactions, newest first, paged. Period defaults to the
     *  current calendar month; user_id narrows to one user (the Users-tab drill-down). */
    public function getTransactions(array $request): array
    {
        if ($err = $this->requireAdmin($request)) return $err;
        $ve = $this->ve();
        if (!$ve) return ['success' => false, 'available' => false, 'rows' => [], 'total' => 0];
        $q = $request['query'] ?? [];
        $page    = max(1, (int)($q['page'] ?? 1));
        $perPage = max(1, min(100, (int)($q['per_page'] ?? 20)));
        $where = [];
        $params = [];
        if (!empty($q['user_id'])) { $where[] = 'user_id = :uid'; $params[':uid'] = (int)$q['user_id']; }
        if (!empty($q['all'])) {
            // no period filter
        } elseif (!empty($q['days'])) {
            $where[] = 'created_at >= DATE_SUB(NOW(), INTERVAL :days DAY)';
            $params[':days'] = max(1, min(365, (int)$q['days']));
        } else {
            $month = (string)($q['month'] ?? '');
            if (!preg_match('/^\d{4}-\d{2}$/', $month)) $month = date('Y-m');
            $where[] = "DATE_FORMAT(created_at, '%Y-%m') = :month";
            $params[':month'] = $month;
        }
        $w = $where ? ('WHERE ' . implode(' AND ', $where)) : '';
        try {
            $c = $ve->prepare("SELECT COUNT(*) FROM video_edit_usage $w");
            $c->execute($params);
            $total = (int)$c->fetchColumn();
            $s = $ve->prepare("SELECT id, user_id, kind, provider, model, units, cost_usd, status, created_at
                FROM video_edit_usage $w ORDER BY id DESC LIMIT :lim OFFSET :off");
            foreach ($params as $k => $v) $s->bindValue($k, $v);
            $s->bindValue(':lim', $perPage, PDO::PARAM_INT);
            $s->bindValue(':off', ($page - 1) * $perPage, PDO::PARAM_INT);
            $s->execute();
            $rows = $s->fetchAll();
            $names = $this->usersById(array_values(array_unique(array_column($rows, 'user_id'))));
            foreach ($rows as &$r) {
                $u = $names[$r['user_id']] ?? null;
                $r['email'] = $u['email'] ?? null;
                $r['name']  = $u['name'] ?? null;
            }
            return ['success' => true, 'available' => true, 'rows' => $rows,
                    'total' => $total, 'page' => $page, 'per_page' => $perPage];
        } catch (\Throwable $e) {
            return ['success' => false, 'available' => false, 'rows' => [], 'total' => 0];
        }
    }

    /** GET /api/v1/admin/video-editor/usage/summary — per-kind cost/generation totals
     *  bucketed today / this week (ISO, since Monday) / this month (calendar) / all time,
     *  plus a last-30-day by-model breakdown. Shaped for the Costs-style Usage & costs
     *  panel. All money is USD; the client converts for display. */
    public function getUsageSummary(array $request): array
    {
        $ve = $this->ve();
        if (!$ve) return ['success' => false, 'available' => false, 'message' => 'Video-edit usage DB not reachable'];
        $blank = static fn() => [
            'totals' => ['today' => 0.0, 'week' => 0.0, 'month' => 0.0, 'total' => 0.0],
            'counts' => ['today' => 0,   'week' => 0,   'month' => 0,   'total' => 0],
            'byModel' => [],
        ];
        $kinds = [];
        foreach (['video', 'image', 'music'] as $k) $kinds[$k] = $blank();
        try {
            $weekStart  = "DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)";
            $monthStart = "DATE_FORMAT(CURDATE(), '%Y-%m-01')";
            $buckets = $ve->query("SELECT kind,
                    COALESCE(SUM(CASE WHEN DATE(created_at)=CURDATE() THEN cost_usd END),0) cost_today,
                    COALESCE(SUM(CASE WHEN created_at >= $weekStart THEN cost_usd END),0) cost_week,
                    COALESCE(SUM(CASE WHEN created_at >= $monthStart THEN cost_usd END),0) cost_month,
                    COALESCE(SUM(cost_usd),0) cost_total,
                    COALESCE(SUM(DATE(created_at)=CURDATE()),0) gen_today,
                    COALESCE(SUM(created_at >= $weekStart),0) gen_week,
                    COALESCE(SUM(created_at >= $monthStart),0) gen_month,
                    COUNT(*) gen_total
                FROM video_edit_usage GROUP BY kind")->fetchAll();
            foreach ($buckets as $r) {
                $k = (string)$r['kind'];
                if (!isset($kinds[$k])) $kinds[$k] = $blank();
                $kinds[$k]['totals'] = [
                    'today' => (float)$r['cost_today'], 'week' => (float)$r['cost_week'],
                    'month' => (float)$r['cost_month'], 'total' => (float)$r['cost_total'],
                ];
                $kinds[$k]['counts'] = [
                    'today' => (int)$r['gen_today'], 'week' => (int)$r['gen_week'],
                    'month' => (int)$r['gen_month'], 'total' => (int)$r['gen_total'],
                ];
            }
            $byModel = $ve->query("SELECT kind, model, COUNT(*) generations,
                    COALESCE(SUM(units),0) units, COALESCE(SUM(cost_usd),0) cost, MAX(created_at) last_used
                FROM video_edit_usage WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
                GROUP BY kind, model ORDER BY cost DESC")->fetchAll();
            foreach ($byModel as $r) {
                $k = (string)$r['kind'];
                if (!isset($kinds[$k])) $kinds[$k] = $blank();
                $kinds[$k]['byModel'][] = [
                    'model' => $r['model'],
                    'generations' => (int)$r['generations'],
                    'units' => (float)$r['units'],
                    'cost' => (float)$r['cost'],
                    'last_used' => $r['last_used'],
                ];
            }
            return ['success' => true, 'available' => true, 'kinds' => $kinds];
        } catch (\Throwable $e) {
            return ['success' => false, 'available' => false, 'message' => 'Usage summary query failed'];
        }
    }

    /** GET /api/v1/admin/video-editor/prices — the editable price table. */
    public function getPrices(array $request): array
    {
        $ve = $this->ve();
        if (!$ve) return ['success' => false, 'prices' => []];
        try {
            $prices = $ve->query("SELECT model, unit, rate, label, updated_at FROM video_edit_prices ORDER BY model")->fetchAll();
            return ['success' => true, 'prices' => $prices];
        } catch (\Throwable $e) {
            return ['success' => false, 'prices' => []];
        }
    }

    /** POST /api/v1/admin/video-editor/prices — upsert one model's rate. */
    public function savePrice(array $request): array
    {
        $ve = $this->ve();
        if (!$ve) return ['success' => false, 'message' => 'DB not reachable'];
        $b = $request['body'] ?? [];
        $model = trim((string)($b['model'] ?? ''));
        $unit  = in_array($b['unit'] ?? '', ['sec', 'image', 'clip'], true) ? $b['unit'] : null;
        if ($model === '' || $unit === null || !isset($b['rate'])) {
            return ['success' => false, 'message' => 'model, unit (sec|image|clip) and rate are required'];
        }
        try {
            $s = $ve->prepare("INSERT INTO video_edit_prices (model, unit, rate, label)
                VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE unit=VALUES(unit), rate=VALUES(rate), label=VALUES(label)");
            $s->execute([$model, $unit, (float)$b['rate'], (string)($b['label'] ?? '')]);
            return ['success' => true];
        } catch (\Throwable $e) {
            return ['success' => false, 'message' => 'Save failed'];
        }
    }

    /** GET /api/v1/admin/video-editor/providers — provider credentials (key MASKED:
     *  only has_key is returned, never the secret). */
    public function getProviders(array $request): array
    {
        if ($err = $this->requireAdmin($request)) return $err;
        $ve = $this->ve();
        if (!$ve) return ['success' => false, 'providers' => []];
        try {
            // Base rows never reference models_json, so a not-yet-migrated DB still works.
            // api_key is returned in the clear: this endpoint is admin-gated and the admin
            // UI shows keys masked with an eye-reveal (same policy as per-role package keys).
            $rows = $ve->query("SELECT provider, label, api_base, enabled, api_key,
                (api_key IS NOT NULL AND api_key <> '') AS has_key, updated_at
                FROM video_edit_providers ORDER BY provider")->fetchAll();

            // Preferred source: the new per-provider models_json catalog (empty if the column
            // hasn't been added yet).
            $mjson = [];
            try {
                foreach ($ve->query("SELECT provider, models_json FROM video_edit_providers") as $r) {
                    $d = json_decode((string)($r['models_json'] ?? ''), true);
                    if (is_array($d) && $d) $mjson[$r['provider']] = array_values($d);
                }
            } catch (\Throwable $e) { /* models_json column not added yet */ }

            // Legacy fallback: the old video_edit_models + video_edit_prices tables, so the
            // catalog keeps showing before the migration SQL is run.
            $legacy = [];
            try {
                foreach ($ve->query("SELECT m.provider, m.model, m.label, m.kind, pr.unit, pr.rate
                        FROM video_edit_models m LEFT JOIN video_edit_prices pr ON pr.model = m.model
                        ORDER BY m.model") as $r) {
                    $kind = (string)($r['kind'] ?? 'video');
                    $legacy[$r['provider']][] = [
                        'model' => $r['model'],
                        'label' => (string)($r['label'] ?? ''),
                        'kind'  => $kind,
                        'cost'  => (float)($r['rate'] ?? 0),
                        'unit'  => (string)($r['unit'] ?? ($kind === 'image' ? 'image' : ($kind === 'music' ? 'clip' : 'sec'))),
                    ];
                }
            } catch (\Throwable $e) { /* old tables already dropped */ }

            foreach ($rows as &$r) {
                $r['enabled'] = (int)$r['enabled'];
                $r['has_key'] = (bool)$r['has_key'];
                $prov = $r['provider'];
                $r['models'] = !empty($mjson[$prov]) ? $mjson[$prov] : ($legacy[$prov] ?? []);
            }
            return ['success' => true, 'providers' => $rows];
        } catch (\Throwable $e) {
            return ['success' => false, 'providers' => []];
        }
    }

    /** POST /api/v1/admin/video-editor/providers — upsert a provider. A blank/omitted
     *  api_key leaves the stored key untouched (so editing never wipes the secret). */
    public function saveProvider(array $request): array
    {
        if ($err = $this->requireAdmin($request)) return $err;
        $ve = $this->ve();
        if (!$ve) return ['success' => false, 'message' => 'DB not reachable'];
        $b = $request['body'] ?? [];
        $provider = trim((string)($b['provider'] ?? ''));
        if ($provider === '') return ['success' => false, 'message' => 'provider is required'];
        $label   = (string)($b['label'] ?? $provider);
        $apiBase = (string)($b['api_base'] ?? '');
        $enabled = !empty($b['enabled']) ? 1 : 0;
        $apiKey  = trim((string)($b['api_key'] ?? ''));
        // The provider's model catalog (+ cost) lives here now, as a JSON string.
        $modelsJson = null;
        if (array_key_exists('models', $b) && is_array($b['models'])) {
            $clean = [];
            foreach ($b['models'] as $m) {
                $mid = trim((string)($m['model'] ?? ''));
                if ($mid === '') continue;
                $row = [
                    'model' => $mid,
                    'label' => (string)($m['label'] ?? ''),
                    'kind'  => in_array($m['kind'] ?? '', ['video', 'image', 'music'], true) ? $m['kind'] : 'video',
                    'cost'  => (float)($m['cost'] ?? 0),
                    'unit'  => (string)($m['unit'] ?? ''),
                ];
                // Optional metadata consumed by video-edit's api/models.php.
                $cid = trim((string)($m['client_id'] ?? ''));
                if ($cid !== '') $row['client_id'] = $cid;
                if (array_key_exists('start_frame', $m)) $row['start_frame'] = (bool)$m['start_frame'];
                if (array_key_exists('end_frame', $m))   $row['end_frame']   = (bool)$m['end_frame'];
                $clean[] = $row;
            }
            $modelsJson = json_encode($clean);
        }
        try {
            // Build the column set conditionally: a blank api_key keeps the stored key,
            // and omitting "models" keeps the existing catalog.
            $cols = ['provider' => $provider, 'label' => $label, 'api_base' => $apiBase, 'enabled' => $enabled];
            if ($apiKey !== '') $cols['api_key'] = $apiKey;
            elseif (!empty($b['clear_key'])) $cols['api_key'] = null;   // explicit removal only
            if ($modelsJson !== null) $cols['models_json'] = $modelsJson;
            $fields  = implode(', ', array_keys($cols));
            $holders = implode(', ', array_map(fn($k) => ":$k", array_keys($cols)));
            $updates = implode(', ', array_map(fn($k) => "$k=VALUES($k)",
                array_values(array_filter(array_keys($cols), fn($k) => $k !== 'provider'))));
            $s = $ve->prepare("INSERT INTO video_edit_providers ($fields) VALUES ($holders)
                ON DUPLICATE KEY UPDATE $updates");
            $params = [];
            foreach ($cols as $k => $v) $params[":$k"] = $v;
            $s->execute($params);
            return ['success' => true];
        } catch (\Throwable $e) {
            return ['success' => false, 'message' => 'Save failed'];
        }
    }

    /** GET /api/v1/admin/video-editor/models — the model catalog (per provider). */
    public function getModels(array $request): array
    {
        if ($err = $this->requireAdmin($request)) return $err;
        $ve = $this->ve();
        if (!$ve) return ['success' => false, 'models' => []];
        try {
            $rows = $ve->query("SELECT model, provider, kind, label, enabled, updated_at
                FROM video_edit_models ORDER BY provider, model")->fetchAll();
            foreach ($rows as &$r) { $r['enabled'] = (int)$r['enabled']; }
            return ['success' => true, 'models' => $rows];
        } catch (\Throwable $e) {
            return ['success' => false, 'models' => []];
        }
    }

    /** POST /api/v1/admin/video-editor/models — upsert one model. */
    public function saveModel(array $request): array
    {
        if ($err = $this->requireAdmin($request)) return $err;
        $ve = $this->ve();
        if (!$ve) return ['success' => false, 'message' => 'DB not reachable'];
        $b = $request['body'] ?? [];
        $model    = trim((string)($b['model'] ?? ''));
        $provider = trim((string)($b['provider'] ?? ''));
        $kind     = in_array($b['kind'] ?? '', ['video', 'image', 'music'], true) ? $b['kind'] : null;
        if ($model === '' || $provider === '' || $kind === null) {
            return ['success' => false, 'message' => 'model, provider and kind (video|image|music) are required'];
        }
        $enabled = !empty($b['enabled']) ? 1 : 0;
        try {
            $s = $ve->prepare("INSERT INTO video_edit_models (model, provider, kind, label, enabled)
                VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE
                provider=VALUES(provider), kind=VALUES(kind), label=VALUES(label), enabled=VALUES(enabled)");
            $s->execute([$model, $provider, $kind, (string)($b['label'] ?? $model), $enabled]);
            return ['success' => true];
        } catch (\Throwable $e) {
            return ['success' => false, 'message' => 'Save failed'];
        }
    }

    /** GET /api/v1/admin/video-editor/user-override?user_id= — a user's capability
     *  override + which providers have a BYO key (keys are masked). */
    public function getUserOverride(array $request): array
    {
        if ($err = $this->requireAdmin($request)) return $err;
        $ve = $this->ve();
        if (!$ve) return ['success' => false, 'message' => 'DB not reachable'];
        $uid = (int)($request['query']['user_id'] ?? 0);
        if ($uid <= 0) return ['success' => false, 'message' => 'user_id is required'];
        try {
            $s = $ve->prepare("SELECT capabilities, byo_keys FROM video_edit_user_overrides WHERE user_id = ? LIMIT 1");
            $s->execute([$uid]);
            $r = $s->fetch();
            $caps = $r ? json_decode((string)$r['capabilities'], true) : null;
            $byo  = $r ? json_decode((string)$r['byo_keys'], true) : null;
            $byoProviders = [];
            if (is_array($byo)) {
                foreach ($byo as $prov => $val) { if ((string)$val !== '') $byoProviders[] = $prov; }
            }
            return ['success' => true, 'user_id' => $uid,
                'capabilities' => is_array($caps) ? $caps : null,
                'byo_providers' => $byoProviders];
        } catch (\Throwable $e) {
            return ['success' => false, 'message' => 'Load failed'];
        }
    }

    /** POST /api/v1/admin/video-editor/user-override — upsert a user's override.
     *  Body: { user_id, capabilities: {...}|null, byo_keys: {provider: key} }.
     *  A blank BYO value keeps the existing key; "__clear__" removes it. */
    public function saveUserOverride(array $request): array
    {
        if ($err = $this->requireAdmin($request)) return $err;
        $ve = $this->ve();
        if (!$ve) return ['success' => false, 'message' => 'DB not reachable'];
        $b = $request['body'] ?? [];
        $uid = (int)($b['user_id'] ?? 0);
        if ($uid <= 0) return ['success' => false, 'message' => 'user_id is required'];
        $caps = array_key_exists('capabilities', $b) ? $b['capabilities'] : null;
        $capsJson = is_array($caps) ? json_encode($caps) : null;
        $incoming = is_array($b['byo_keys'] ?? null) ? $b['byo_keys'] : [];
        $adminId = is_numeric($request['user_id'] ?? null) ? (int)$request['user_id'] : null;
        try {
            $s = $ve->prepare("SELECT byo_keys FROM video_edit_user_overrides WHERE user_id = ? LIMIT 1");
            $s->execute([$uid]);
            $existing = $s->fetchColumn();
            $byo = $existing ? (json_decode((string)$existing, true) ?: []) : [];
            foreach ($incoming as $prov => $val) {
                $val = (string)$val;
                if ($val === '') continue;                       // keep existing
                if ($val === '__clear__') { unset($byo[$prov]); continue; }
                $byo[$prov] = $val;
            }
            $byoJson = $byo ? json_encode($byo) : null;
            $u = $ve->prepare("INSERT INTO video_edit_user_overrides (user_id, capabilities, byo_keys, updated_by)
                VALUES (:u, :c, :b, :by)
                ON DUPLICATE KEY UPDATE capabilities = VALUES(capabilities), byo_keys = VALUES(byo_keys), updated_by = VALUES(updated_by)");
            $u->execute([':u' => $uid, ':c' => $capsJson, ':b' => $byoJson, ':by' => $adminId]);
            return ['success' => true];
        } catch (\Throwable $e) {
            return ['success' => false, 'message' => 'Save failed'];
        }
    }

    /** GET /api/v1/admin/video-editor/packages — role → capabilities (video-edit DB). */
    public function getPackages(array $request): array
    {
        if ($err = $this->requireAdmin($request)) return $err;
        $ve = $this->ve();
        if (!$ve) return ['success' => false, 'packages' => []];
        try {
            $rows = $ve->query("SELECT role, capabilities, updated_at FROM video_edit_packages ORDER BY role")->fetchAll();
            foreach ($rows as &$r) {
                $d = json_decode((string)$r['capabilities'], true);
                $r['capabilities'] = is_array($d) ? $d : new \stdClass();
            }
            return ['success' => true, 'packages' => $rows];
        } catch (\Throwable $e) {
            return ['success' => false, 'packages' => []];
        }
    }

    /** POST /api/v1/admin/video-editor/packages — upsert one role's capabilities.
     *  Body: { role, capabilities: {...} }. */
    public function savePackage(array $request): array
    {
        if ($err = $this->requireAdmin($request)) return $err;
        $ve = $this->ve();
        if (!$ve) return ['success' => false, 'message' => 'DB not reachable'];
        $b = $request['body'] ?? [];
        $role = (string)($b['role'] ?? '');
        $valid = ['guest', 'prospect', 'user', 'admin', 'affiliate'];
        if (!in_array($role, $valid, true)) return ['success' => false, 'message' => 'invalid role'];
        $caps = $b['capabilities'] ?? null;
        if (!is_array($caps)) return ['success' => false, 'message' => 'capabilities object is required'];
        $adminId = is_numeric($request['user_id'] ?? null) ? (int)$request['user_id'] : null;
        try {
            $s = $ve->prepare("INSERT INTO video_edit_packages (role, capabilities, updated_by)
                VALUES (:r, :c, :by) ON DUPLICATE KEY UPDATE capabilities = VALUES(capabilities), updated_by = VALUES(updated_by)");
            $s->execute([':r' => $role, ':c' => json_encode($caps), ':by' => $adminId]);
            return ['success' => true];
        } catch (\Throwable $e) {
            return ['success' => false, 'message' => 'Save failed'];
        }
    }

    /** GET /api/v1/admin/video-editor/users?q= — login users + their video-edit role.
     *  User names come from the login DB; roles live in the video-edit DB
     *  (app_user_roles), so no cross-DB grant is needed. */
    public function getUsers(array $request): array
    {
        if ($err = $this->requireAdmin($request)) return $err;
        $login = $this->login();
        if (!$login) return ['success' => false, 'available' => false, 'users' => [],
            'message' => 'Login DB not reachable — set LOGIN_DB_* in gpt/backend/.env'];
        $q = trim((string)($request['query']['q'] ?? ''));
        try {
            $params = [];
            $where = '';
            if ($q !== '') {
                $where = "WHERE (email LIKE :q OR first_name LIKE :q OR last_name LIKE :q)";
                $params[':q'] = "%$q%";
            }
            $s = $login->prepare("SELECT id, email, first_name, last_name, provider, email_verified, last_login
                    FROM users $where ORDER BY id DESC LIMIT 100");
            $s->execute($params);
            $rows = $s->fetchAll();

            // Roles from the CENTRALIZED login DB, keyed by user id.
            $roles = [];
            $appId = $this->veAppId();
            if ($appId !== null) {
                $rs = $login->prepare("SELECT user_id, role FROM app_user_roles WHERE app_id = ?");
                $rs->execute([$appId]);
                foreach ($rs->fetchAll() as $rr) $roles[(int)$rr['user_id']] = $rr['role'];
            }
            foreach ($rows as &$r) {
                $name = trim(($r['first_name'] ?? '') . ' ' . ($r['last_name'] ?? ''));
                $r['name'] = $name !== '' ? $name : ($r['email'] ?? '');
                $r['email_verified'] = (int)($r['email_verified'] ?? 0);
                $r['ve_role'] = $roles[(int)$r['id']] ?? null;
                unset($r['first_name'], $r['last_name']);
            }
            return ['success' => true, 'available' => true, 'app' => self::APP, 'users' => $rows];
        } catch (\Throwable $e) {
            return ['success' => false, 'available' => false, 'users' => [],
                'message' => 'User query failed — check the login DB connection'];
        }
    }

    /** POST /api/v1/admin/video-editor/users/role — set (or clear) a user's video-edit role.
     *  Body: { user_id, role }. An empty/"none" role revokes. Stored in the
     *  CENTRALIZED login DB (login.app_user_roles keyed by registered_apps.id). */
    public function setUserRole(array $request): array
    {
        if ($err = $this->requireAdmin($request)) return $err;
        $login = $this->login();
        if (!$login) return ['success' => false, 'message' => 'Login DB not reachable'];
        $appId = $this->veAppId();
        if ($appId === null) return ['success' => false, 'message' => 'video-edit app not registered in login'];
        $b = $request['body'] ?? [];
        $uid = (int)($b['user_id'] ?? 0);
        $role = (string)($b['role'] ?? '');
        if ($uid <= 0) return ['success' => false, 'message' => 'user_id is required'];
        $adminId = is_numeric($request['user_id'] ?? null) ? (int)$request['user_id'] : null;
        $valid = ['guest', 'prospect', 'user', 'admin', 'affiliate'];
        try {
            if ($role === '' || $role === 'none') {
                $s = $login->prepare("DELETE FROM app_user_roles WHERE user_id = :u AND app_id = :a");
                $s->execute([':u' => $uid, ':a' => $appId]);
            } else {
                if (!in_array($role, $valid, true)) return ['success' => false, 'message' => 'invalid role'];
                $s = $login->prepare("INSERT INTO app_user_roles (user_id, app_id, role, updated_by)
                    VALUES (:u, :a, :r, :by)
                    ON DUPLICATE KEY UPDATE role = VALUES(role), updated_by = VALUES(updated_by)");
                $s->execute([':u' => $uid, ':a' => $appId, ':r' => $role, ':by' => $adminId]);
            }
            return ['success' => true];
        } catch (\Throwable $e) {
            return ['success' => false, 'message' => 'Save failed'];
        }
    }
}
