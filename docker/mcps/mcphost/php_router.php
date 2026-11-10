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
if ($first === 'data' || preg_match('/^server\.log(\..*)?$/', basename($path))) {
    http_response_code(404);
    return true;
}
$file = $_SERVER['DOCUMENT_ROOT'] . $path;
if ($path !== '/' && is_file($file)) {
    return false;
}
http_response_code(404);
return true;
