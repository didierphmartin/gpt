FROM php:8.3-apache

# Extension set derived from backend/composer.lock's platform requirements.
# ctype, curl, dom, fileinfo, filter, iconv, json, libxml, mbstring, pcre,
# phar, simplexml, tokenizer, xml*, zlib are already in the base image.
# `curl` (the CLI binary, not the PHP extension) is added here too: the
# HEALTHCHECK below invokes it inside the container, and php:8.3-apache does
# not guarantee it's present.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        libzip-dev libpng-dev libjpeg62-turbo-dev libfreetype6-dev \
        libicu-dev libxml2-dev libxslt1-dev libsodium-dev \
        default-mysql-client unzip curl; \
    docker-php-ext-configure gd --with-freetype --with-jpeg; \
    docker-php-ext-install -j"$(nproc)" pdo_mysql gd intl zip soap xsl sodium; \
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

# Public and file-backed (ModelCatalogController reads resources/model_catalog.json),
# so this proves Apache + PHP + routing + .htaccess without credentials or a database.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
  CMD curl -fsS http://localhost/gpt/backend/api/v1/models/catalog || exit 1

ENTRYPOINT ["gpt-entrypoint"]
CMD ["apache2-foreground"]
