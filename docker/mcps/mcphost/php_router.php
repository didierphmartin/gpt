<?php
// Router for `php -S`: serves existing files under the docroot, never dotfiles (.env, .git, .htaccess).
$path = rawurldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?? '');
foreach (explode('/', $path) as $seg) {
    if ($seg !== '' && $seg[0] === '.') {
        http_response_code(404);
        return true;
    }
}
$file = $_SERVER['DOCUMENT_ROOT'] . $path;
if ($path !== '/' && is_file($file)) {
    return false;
}
http_response_code(404);
return true;
