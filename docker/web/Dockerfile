FROM php:8.3-apache

# Extension set derived from backend/composer.lock's platform requirements.
# ctype, curl, dom, fileinfo, filter, iconv, json, libxml, mbstring, pcre,
# phar, simplexml, tokenizer, xml*, zlib are already in the base image.
# `curl` (the CLI binary, not the PHP extension) is added here too: the
# HEALTHCHECK below invokes it inside the container, and php:8.3-apache does
# not guarantee it's present.
RUN set -eux; \
    savedAptMark="$(apt-mark showmanual)"; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        libzip-dev libpng-dev libjpeg62-turbo-dev libfreetype6-dev \
        libicu-dev libxml2-dev libxslt1-dev libsodium-dev \
        default-mysql-client curl unzip; \
    docker-php-ext-configure gd --with-freetype --with-jpeg; \
    docker-php-ext-install -j"$(nproc)" pdo_mysql gd intl zip soap xsl sodium; \
    \
    # Mark everything auto, restore the original manual set, then re-mark the
    # runtime libraries the built extensions actually link against, so the
    # autoremove below drops only the build-time headers.
    apt-mark auto '.*' > /dev/null; \
    apt-mark manual $savedAptMark > /dev/null; \
    apt-mark manual default-mysql-client curl > /dev/null; \
    # readlink -f resolves each /lib/... path to the /usr/lib/... path dpkg
    # actually records: this base image's Debian release merges /lib into
    # /usr/lib via a symlink, and dpkg-query --search matches on the
    # canonical path only, so skipping this step silently finds zero owning
    # packages and the purge below removes every runtime library.
    ldd "$(php -r 'echo ini_get("extension_dir");')"/*.so \
        | awk '/=>/ { so = $(NF-1); if (index(so, "/usr/local/") == 1) next; print so; }' \
        | sort -u \
        | xargs -r readlink -f \
        | sort -u \
        | xargs -r dpkg-query --search 2>/dev/null \
        | cut -d: -f1 \
        | sort -u \
        | xargs -r apt-mark manual > /dev/null; \
    \
    apt-get purge -y --auto-remove -o APT::AutoRemove::RecommendsImportant=false; \
    rm -rf /var/lib/apt/lists/*

RUN a2enmod rewrite headers

COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
COPY docker/web/apache-gpt.conf /etc/apache2/conf-available/gpt.conf
COPY docker/web/php.ini /usr/local/etc/php/conf.d/zz-gpt.ini
RUN a2enconf gpt

WORKDIR /var/www/html/gpt

# Dependencies first, so editing app code does not re-resolve Composer.
COPY backend/composer.json backend/composer.lock ./backend/
RUN cd backend && composer install \
        --no-dev --no-scripts --no-autoloader --prefer-dist --no-interaction

COPY . .
RUN cd backend && composer dump-autoload --optimize --no-dev --no-interaction

COPY docker/web/entrypoint.sh /usr/local/bin/gpt-entrypoint
RUN chmod +x /usr/local/bin/gpt-entrypoint \
 && mkdir -p /run/gpt \
 && chown -R www-data:www-data /var/www/html/gpt /run/gpt

# backend/index.php opens a PDO connection and exit()s on failure before the
# dispatcher that would route to ModelCatalogController even exists, so this
# route returns HTTP 500 without a reachable database (see
# docker/tests/image-test.sh, which asserts exactly that failure mode against
# the image alone). Inside the compose stack that DB dependency is exactly
# what we want a healthcheck to prove: not just that Apache/PHP answer
# requests, but that the web container can reach its database too --
# "healthy" should mean the app actually works, not just that Apache is up.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
  CMD curl -fsS http://localhost/gpt/backend/api/v1/models/catalog || exit 1

ENTRYPOINT ["gpt-entrypoint"]
CMD ["apache2-foreground"]
