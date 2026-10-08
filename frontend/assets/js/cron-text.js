/**
 * Cron for the Start node's schedule: validation and a plain-language description.
 * Same rules as backend CronExpression.php (5 fields, *, n, a-b, /step, lists; dow 0/7 = Sunday).
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CronText = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
    const ITEM = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/;
    const PRESETS = [
        { key: 'every2', expr: '*/2 * * * *' },
        { key: 'every15', expr: '*/15 * * * *' },
        { key: 'officeHours', expr: '*/5 8-18 * * 1-5' },
    ];

    function fieldOk(f, [lo, hi]) {
        return f.split(',').every((item) => {
            const m = ITEM.exec(item);
            if (!m) return false;
            let a = lo, b = hi;
            if (m[1] !== '*') [a, b] = m[1].includes('-') ? m[1].split('-').map(Number) : [Number(m[1]), Number(m[1])];
            const step = m[2] === undefined ? 1 : Number(m[2]);
            return a >= lo && b <= hi && a <= b && step >= 1;
        });
    }

    /** null when valid, else the i18n key of the problem. */
    function validate(expr) {
        const parts = String(expr || '').trim().split(/\s+/);
        if (parts.length !== 5 || parts[0] === '') return 'workflow.schedule.cron.errFields';
        return parts.every((p, i) => fieldOk(p, RANGES[i])) ? null : 'workflow.schedule.cron.errRange';
    }

    const pad = (n) => String(n).padStart(2, '0');
    const dayNames = (dow, t) => dow.replace(/\d/g, (d) => t(`workflow.schedule.cron.day${d === '7' ? 0 : d}`))
        .replace(/-/g, '–').replace(/,/g, ', ');

    function describe(expr, t) {
        if (validate(expr)) return '';
        const [mi, ho, dom, mo, dow] = expr.trim().split(/\s+/);
        const k = (s) => `workflow.schedule.cron.${s}`;
        const fixedTime = /^\d+$/.test(mi) && /^\d+$/.test(ho);
        const parts = [];
        if (fixedTime) parts.push(t(k('atTime'), { time: `${pad(ho)}:${pad(mi)}` }));
        else if (mi === '*') parts.push(t(k('everyMinute')));
        else if (/^\*\/\d+$/.test(mi)) parts.push(t(k('everyNMinutes'), { n: mi.slice(2) }));
        else parts.push(t(k('atMinutes'), { list: mi }));
        if (!fixedTime && ho !== '*') parts.push(t(k('duringHours'), { hours: ho.replace(/-/g, '–') }));
        if (dom !== '*') parts.push(t(k('onDaysOfMonth'), { days: dom }));
        if (mo !== '*') parts.push(t(k('inMonths'), { months: mo }));
        if (dow !== '*') parts.push(t(k('onWeekdays'), { days: dayNames(dow, t) }));
        return parts.join(', ');
    }

    return { validate, describe, PRESETS };
});
