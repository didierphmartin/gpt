<?php
declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * A standard 5-field cron expression (minute hour day-of-month month day-of-week), server timezone.
 * Fields take *, n, a-b, and /step on either, comma-separated. Day-of-week 0 and 7 are Sunday.
 * When both day fields are restricted, a day matches either (standard cron).
 * The compiled LangGraph script embeds the same rules (LangGraphRuntime::cronBlock()).
 */
final class CronExpression
{
    private const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
    /** About 5 years of days plus hours: enough for a leap day, bounded for never-firing input. */
    private const MAX_STEPS = 60000;

    /** @var array<int, array<int, true>> */
    private array $sets = [];
    private bool $domStar;
    private bool $dowStar;

    public function __construct(string $expr)
    {
        $parts = preg_split('/\s+/', trim($expr));
        if (count($parts) !== 5) {
            throw new \InvalidArgumentException('cron needs 5 fields: minute hour day-of-month month day-of-week');
        }
        foreach ($parts as $i => $p) {
            $this->sets[$i] = self::field($p, self::RANGES[$i][0], self::RANGES[$i][1]);
        }
        if (isset($this->sets[4][7])) {
            $this->sets[4][0] = true;
            unset($this->sets[4][7]);
        }
        $this->domStar = $parts[2] === '*';
        $this->dowStar = $parts[4] === '*';
    }

    public static function isValid(string $expr): bool
    {
        try {
            (new self($expr))->nextAfter(new \DateTimeImmutable());
            return true;
        } catch (\InvalidArgumentException | \RuntimeException) {
            return false;
        }
    }

    /** @return array<int, true> */
    private static function field(string $f, int $lo, int $hi): array
    {
        $out = [];
        foreach (explode(',', $f) as $item) {
            if (!preg_match('/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/', $item, $m)) {
                throw new \InvalidArgumentException("bad cron field '{$f}'");
            }
            if ($m[1] === '*') {
                [$a, $b] = [$lo, $hi];
            } elseif (str_contains($m[1], '-')) {
                [$a, $b] = array_map('intval', explode('-', $m[1]));
            } else {
                $a = $b = (int) $m[1];
                if (isset($m[2])) {
                    $b = $hi;   // "5/10" = from 5, every 10
                }
            }
            $step = isset($m[2]) ? (int) $m[2] : 1;
            if ($a < $lo || $b > $hi || $a > $b || $step < 1) {
                throw new \InvalidArgumentException("cron field '{$f}' is out of range {$lo}-{$hi}");
            }
            for ($v = $a; $v <= $b; $v += $step) {
                $out[$v] = true;
            }
        }
        return $out;
    }

    public function matches(\DateTimeImmutable $t): bool
    {
        return $this->dayMatches($t)
            && isset($this->sets[1][(int) $t->format('G')])
            && isset($this->sets[0][(int) $t->format('i')]);
    }

    private function dayMatches(\DateTimeImmutable $t): bool
    {
        if (!isset($this->sets[3][(int) $t->format('n')])) {
            return false;
        }
        $dom = isset($this->sets[2][(int) $t->format('j')]);
        $dow = isset($this->sets[4][(int) $t->format('w')]);
        return ($this->domStar || $this->dowStar) ? ($dom && $dow) : ($dom || $dow);
    }

    /** The first minute strictly after $after that matches. */
    public function nextAfter(\DateTimeImmutable $after): \DateTimeImmutable
    {
        $t = $after->setTime((int) $after->format('G'), (int) $after->format('i'))->modify('+1 minute');
        for ($i = 0; $i < self::MAX_STEPS; $i++) {
            if (!$this->dayMatches($t)) {
                $t = $t->setTime(0, 0)->modify('+1 day');
                continue;
            }
            if (!isset($this->sets[1][(int) $t->format('G')])) {
                $t = $t->setTime((int) $t->format('G'), 0)->modify('+1 hour');
                continue;
            }
            for ($m = (int) $t->format('i'); $m < 60; $m++) {
                if (isset($this->sets[0][$m])) {
                    return $t->setTime((int) $t->format('G'), $m);
                }
            }
            $t = $t->setTime((int) $t->format('G'), 0)->modify('+1 hour');
        }
        throw new \RuntimeException('cron expression never fires');
    }
}
