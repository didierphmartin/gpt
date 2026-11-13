<?php
// Router for `php -S`: serves existing files under the docroot, never dotfiles (.env, .git, .htaccess),
// the supervisor's server.log[.N], or the server's data/ folder.
$path = rawurldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?? '');
$segs = explode('/', $path);
foreach ($segs as $seg) {
    if ($seg !== '' && $seg[0] === '.') {
        http_response_code(404);
        return true;
    }
}
$first = $segs[1] ?? '';
$base = strtolower(basename($path));
// \.env$: a settings file under any name (config/pdi.env held a ServiceNow login); a .env.example is a template
$secret = '/^server\.log(\..*)?$|\.sqlite|\.log$|\.(pem|key|p12|pfx)$|\.env$|^(credentials|token).*\.json$|secret/';
if ($first === 'data' || preg_match($secret, $base)) {
    http_response_code(404);
    return true;
}
$file = $_SERVER['DOCUMENT_ROOT'] . $path;
if ($path !== '/' && is_file($file)) {
    return false;
}
http_response_code(404);
return true;
