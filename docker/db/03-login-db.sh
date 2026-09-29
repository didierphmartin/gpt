#!/bin/bash
# Corporate edition only: an empty database for the login service, owned by
# the same MYSQL_USER as gpt's database. Its tables are created by the web
# container (docker/login-schema.php), because the schema lives in the login
# repository. Runs once, on an empty data volume, like the other init files.
LOGIN_DB="${LOGIN_DB_NAME:-gpt_login}"
mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" <<SQL
CREATE DATABASE IF NOT EXISTS \`${LOGIN_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON \`${LOGIN_DB}\`.* TO '${MYSQL_USER}'@'%';
FLUSH PRIVILEGES;
SQL
