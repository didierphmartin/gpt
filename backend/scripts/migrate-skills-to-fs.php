<?php

declare(strict_types=1);

/**
 * One-shot migration: copy every row from the legacy `skills` table to a
 * folder-backed skill under ~/Documents/synergyAI/skills/<slug>/.
 *
 * Output layout per row:
 *   ~/Documents/synergyAI/skills/<slug>/
 *       SKILL.md             ← frontmatter + skill_content body
 *
 * Run from the backend dir (so the autoloader/config resolve):
 *   php scripts/migrate-skills-to-fs.php          # do it
 *   php scripts/migrate-skills-to-fs.php --dry-run    # preview only
 *   php scripts/migrate-skills-to-fs.php --user-id 5  # only one user's rows
 *   php scripts/migrate-skills-to-fs.php --target /abs/path  # override target dir
 *   php scripts/migrate-skills-to-fs.php --force      # overwrite if folder exists
 *
 * After verification, drop the legacy tables yourself:
 *   DROP TABLE skills;
 *   DROP TABLE skill_categories;
 */

// -------- arg parsing ---------------------------------------------------------
$argvLocal  = $argv;
$dryRun     = in_array('--dry-run', $argvLocal, true);
$force      = in_array('--force',  $argvLocal, true);
$userId     = null;
$targetDir  = null;
for ($i = 1; $i < count($argvLocal); $i++) {
    if ($argvLocal[$i] === '--user-id' && isset($argvLocal[$i + 1])) {
        $userId = (int) $argvLocal[$i + 1];
        $i++;
    } elseif ($argvLocal[$i] === '--target' && isset($argvLocal[$i + 1])) {
        $targetDir = rtrim($argvLocal[$i + 1], '/');
        $i++;
    }
}

if ($targetDir === null) {
    $home = getenv('HOME') ?: '';
    if ($home === '') {
        fwrite(STDERR, "ERROR: cannot resolve \$HOME; pass --target /abs/path\n");
        exit(1);
    }
    $targetDir = $home . '/Documents/synergyAI/skills';
}

// -------- config + DB --------------------------------------------------------
$config = require __DIR__ . '/../config/ai_config.php';
$dbConfig = $config['contexts_database'] ?? $config['database'] ?? null;
if (!$dbConfig) {
    fwrite(STDERR, "ERROR: no 'database' or 'contexts_database' section in config/ai_config.php\n");
    exit(1);
}
$dsn = "mysql:host={$dbConfig['host']};dbname={$dbConfig['database']};charset={$dbConfig['charset']}";
$pdo = new PDO($dsn, $dbConfig['username'], $dbConfig['password'], [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
]);

// -------- query --------------------------------------------------------------
$sql = "SELECT s.id, s.user_id, s.name, s.description, s.version, s.skill_content,
               s.default_tools, s.tags, s.visibility, s.enabled,
               c.name AS category_name
        FROM skills s
        LEFT JOIN skill_categories c ON c.id = s.category_id";
$params = [];
if ($userId !== null) {
    $sql .= " WHERE s.user_id = :uid";
    $params[':uid'] = $userId;
}
$sql .= " ORDER BY s.id ASC";

$stmt = $pdo->prepare($sql);
$stmt->execute($params);
$rows = $stmt->fetchAll();

if (!$rows) {
    echo "No skills found" . ($userId !== null ? " for user_id={$userId}" : '') . ". Nothing to migrate.\n";
    exit(0);
}

echo ($dryRun ? "[DRY-RUN] " : "") . "Found " . count($rows) . " skill(s) to migrate to {$targetDir}\n";

// -------- ensure target dir --------------------------------------------------
if (!$dryRun) {
    if (!is_dir($targetDir) && !mkdir($targetDir, 0755, true) && !is_dir($targetDir)) {
        fwrite(STDERR, "ERROR: failed to create target dir {$targetDir}\n");
        exit(1);
    }
}

// -------- migrate ------------------------------------------------------------
$ok = 0; $skipped = 0; $failed = 0;
foreach ($rows as $row) {
    $slug = slugify((string)$row['name']);
    if ($slug === '') {
        $slug = 'skill-' . $row['id'];
    }
    $skillDir = $targetDir . '/' . $slug;
    $skillMdPath = $skillDir . '/SKILL.md';

    if (is_dir($skillDir) && !$force) {
        echo "  SKIP id={$row['id']} '{$row['name']}' — folder exists at {$skillDir} (use --force to overwrite)\n";
        $skipped++;
        continue;
    }

    $tools = jsonOrNull($row['default_tools']);
    $tags  = jsonOrNull($row['tags']);

    $frontmatter = "---\n";
    $frontmatter .= "name: " . ymlString($row['name'] ?: $slug) . "\n";
    if (!empty($row['description'])) {
        $frontmatter .= "description: " . ymlString($row['description']) . "\n";
    }
    if (!empty($row['version'])) {
        $frontmatter .= "version: " . ymlString($row['version']) . "\n";
    }
    if (is_array($tools) && $tools !== []) {
        $frontmatter .= "default_tools: " . ymlArray($tools) . "\n";
    }
    if (is_array($tags) && $tags !== []) {
        $frontmatter .= "tags: " . ymlArray($tags) . "\n";
    }
    if (!empty($row['visibility'])) {
        $frontmatter .= "visibility: " . ymlString($row['visibility']) . "\n";
    }
    if (!empty($row['category_name'])) {
        $frontmatter .= "category: " . ymlString($row['category_name']) . "\n";
    }
    // Provenance — useful when the user is auditing the migration.
    $frontmatter .= "legacy_skill_id: " . (int) $row['id'] . "\n";
    $frontmatter .= "---\n\n";

    // If skill_content already starts with a frontmatter block, strip ours
    // and just write its content — the DB row was already in spec format.
    $body = (string)$row['skill_content'];
    if (preg_match('/^---\s*\n.*?\n---\s*\n/s', $body)) {
        $output = $body;
    } else {
        $output = $frontmatter . $body;
    }

    if ($dryRun) {
        echo "  WOULD WRITE id={$row['id']} '{$row['name']}' → {$skillMdPath} ("
            . strlen($output) . " bytes)\n";
        $ok++;
        continue;
    }

    if (!is_dir($skillDir) && !mkdir($skillDir, 0755, true)) {
        fwrite(STDERR, "  FAIL id={$row['id']} — could not create {$skillDir}\n");
        $failed++;
        continue;
    }
    if (file_put_contents($skillMdPath, $output) === false) {
        fwrite(STDERR, "  FAIL id={$row['id']} — could not write {$skillMdPath}\n");
        $failed++;
        continue;
    }
    echo "  OK   id={$row['id']} '{$row['name']}' → {$skillMdPath}\n";
    $ok++;
}

echo "\n" . ($dryRun ? "[DRY-RUN] " : "") . "Done — {$ok} migrated, {$skipped} skipped, {$failed} failed.\n";
if (!$dryRun) {
    echo "Verify the folders under {$targetDir} look right, refresh the app's Skills sidebar, then drop the legacy tables:\n";
    echo "  DROP TABLE skills;\n";
    echo "  DROP TABLE skill_categories;\n";
}

// =============================================================================
// helpers
// =============================================================================

function slugify(string $name): string
{
    $s = strtolower(trim($name));
    $s = preg_replace('/[^a-z0-9\-_]+/i', '-', $s) ?? '';
    $s = preg_replace('/-+/', '-', $s) ?? '';
    return trim($s, '-_');
}

function jsonOrNull($v): ?array
{
    if ($v === null || $v === '') return null;
    if (is_array($v)) return $v;
    $decoded = json_decode((string)$v, true);
    return is_array($decoded) ? $decoded : null;
}

function ymlString(string $s): string
{
    // Quote strings that need escaping; YAML is tolerant of unquoted simple
    // strings but quoting keeps things unambiguous when the value contains
    // colons, hash, brackets, etc.
    if (preg_match('/[:#\[\]\{\}\&\*!\|\>\'"%@`\n]/', $s)) {
        return '"' . str_replace(['\\', '"'], ['\\\\', '\\"'], $s) . '"';
    }
    return $s;
}

function ymlArray(array $a): string
{
    return '[' . implode(', ', array_map(fn($x) => ymlString((string)$x), $a)) . ']';
}
