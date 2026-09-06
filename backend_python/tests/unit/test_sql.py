from app.support.sql import translate


def test_question_marks_become_pyformat():
    sql, p = translate('SELECT * FROM users WHERE email = ? AND id != ?', ['a@b.c', 3])
    assert sql == 'SELECT * FROM users WHERE email = %s AND id != %s'
    assert p == ['a@b.c', 3]


def test_named_params_with_and_without_colon_keys():
    sql, p = translate('SELECT role FROM users WHERE id = :id LIMIT 1', {':id': 7})
    assert sql == 'SELECT role FROM users WHERE id = %(id)s LIMIT 1'
    assert p == {'id': 7}
    sql2, p2 = translate('UPDATE t SET a = :a WHERE b = :b', {'a': 1, 'b': 2})
    assert sql2 == 'UPDATE t SET a = %(a)s WHERE b = %(b)s' and p2 == {'a': 1, 'b': 2}


def test_percent_is_escaped_only_when_params_present():
    sql, _ = translate("SELECT * FROM t WHERE name LIKE '%x%' AND id = ?", [1])
    assert sql == "SELECT * FROM t WHERE name LIKE '%%x%%' AND id = %s"
    sql2, p2 = translate("SELECT * FROM t WHERE name LIKE '%x%'", None)
    assert sql2 == "SELECT * FROM t WHERE name LIKE '%x%'" and p2 is None


def test_time_literal_colon_is_not_a_param():
    sql, _ = translate("SELECT '12:30' AS t, :name", {'name': 'x'})
    assert sql == "SELECT '12:30' AS t, %(name)s"
