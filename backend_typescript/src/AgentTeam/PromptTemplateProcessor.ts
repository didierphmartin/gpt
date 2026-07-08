/**
 * Faithful port of src/AgentTeam/Services/PromptTemplateProcessor.php.
 *
 * Processes `[placeholder]` template tokens in prompts, replacing them with dynamic values
 * (date/time, user, workflow, system, and `[var:name]` custom variables). The regex, the
 * placeholder match arms and the not-found fallbacks mirror PHP exactly.
 *
 * NOTE on date formatting: PHP uses DateTime->format() with PHP format chars. We reimplement the
 * subset of format chars the match arms use (F j, Y / g:i A / Y / F / n / j / l / Y-m-d / c). The
 * 'c' (ISO 8601) arm is best-effort (local offset); all date/time output is run-time volatile and
 * masked by the differential harness anyway.
 */

type Context = Record<string, any>;

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface DateParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
  weekday: number; // 0 (Sun) - 6 (Sat)
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

function getDateParts(date: Date, tz: string | null): DateParts {
  if (tz) {
    try {
      const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        weekday: 'short',
      });
      const parts: Record<string, string> = {};
      for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
      const weekdayMap: Record<string, number> = {
        Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
      };
      let hour = parseInt(parts.hour, 10);
      if (hour === 24) hour = 0; // Intl can yield '24' for midnight in some envs
      return {
        year: parseInt(parts.year, 10),
        month: parseInt(parts.month, 10),
        day: parseInt(parts.day, 10),
        hour,
        minute: parseInt(parts.minute, 10),
        second: parseInt(parts.second, 10),
        weekday: weekdayMap[parts.weekday] ?? date.getDay(),
      };
    } catch {
      // fall through to local
    }
  }
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    second: date.getSeconds(),
    weekday: date.getDay(),
  };
}

/** Reimplements the subset of PHP date() format chars the processor uses. */
function phpDate(format: string, date: Date, tz: string | null): string {
  const p = getDateParts(date, tz);
  const hour12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  let out = '';
  for (let i = 0; i < format.length; i++) {
    const ch = format[i];
    switch (ch) {
      case 'Y': out += String(p.year); break;
      case 'y': out += pad2(p.year % 100); break;
      case 'm': out += pad2(p.month); break;
      case 'n': out += String(p.month); break;
      case 'd': out += pad2(p.day); break;
      case 'j': out += String(p.day); break;
      case 'F': out += MONTH_NAMES[p.month - 1]; break;
      case 'M': out += MONTH_NAMES[p.month - 1].slice(0, 3); break;
      case 'l': out += DAY_NAMES[p.weekday]; break;
      case 'D': out += DAY_NAMES[p.weekday].slice(0, 3); break;
      case 'H': out += pad2(p.hour); break;
      case 'G': out += String(p.hour); break;
      case 'h': out += pad2(hour12); break;
      case 'g': out += String(hour12); break;
      case 'i': out += pad2(p.minute); break;
      case 's': out += pad2(p.second); break;
      case 'A': out += p.hour < 12 ? 'AM' : 'PM'; break;
      case 'a': out += p.hour < 12 ? 'am' : 'pm'; break;
      case 'c': {
        // ISO 8601 — best-effort with local offset.
        const offMin = -date.getTimezoneOffset();
        const sign = offMin >= 0 ? '+' : '-';
        const abs = Math.abs(offMin);
        out += `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
        break;
      }
      default: out += ch; break;
    }
  }
  return out;
}

export class PromptTemplateProcessor {
  private context: Context = {};
  private timezone: string | null = null;

  /** Set the context for template processing (merge). */
  setContext(context: Context): this {
    this.context = { ...this.context, ...context };
    return this;
  }

  /** Set timezone for date/time formatting. */
  setTimezone(timezone: string): this {
    this.timezone = timezone;
    return this;
  }

  /** Process a prompt string, replacing all `[placeholder]` tokens. */
  process(prompt: string): string {
    return prompt.replace(/\[([a-zA-Z_][a-zA-Z0-9_:]*)\]/g, (_m, name: string) =>
      this.replacePlaceholder(name)
    );
  }

  private replacePlaceholder(placeholder: string): string {
    if (placeholder.startsWith('var:')) {
      return this.getCustomVariable(placeholder.slice(4));
    }

    const now = new Date();
    const fmt = (f: string) => phpDate(f, now, this.timezone);
    const ctx = this.context;

    switch (placeholder) {
      // Date/Time
      case 'date': return fmt('F j, Y');
      case 'time': return fmt('g:i A');
      case 'datetime': return fmt('F j, Y g:i A');
      case 'year': return fmt('Y');
      case 'month': return fmt('F');
      case 'month_num': return fmt('n');
      case 'day': return fmt('j');
      case 'weekday': return fmt('l');
      case 'timezone': return this.getTimezone();
      case 'iso_date': return fmt('Y-m-d');
      case 'iso_datetime': return fmt('c');

      // User
      case 'username': return ctx.username ?? 'User';
      case 'user_email': return ctx.user_email ?? '';
      case 'user_id': return String(ctx.user_id ?? '');
      case 'user_locale': return ctx.user_locale ?? 'en-US';

      // Workflow
      case 'workflow_name': return ctx.workflow_name ?? '';
      case 'workflow_id': return String(ctx.workflow_id ?? '');
      case 'agent_name': return ctx.agent_name ?? '';
      case 'node_name': return ctx.node_name ?? '';
      case 'node_id': return String(ctx.node_id ?? '');
      case 'user_prompt': return ctx.user_prompt ?? '';
      case 'previous_output': return ctx.previous_output ?? '';

      // System
      case 'app_name': return ctx.app_name ?? 'AI Assistant';
      case 'app_version': return ctx.app_version ?? '1.0';

      default: return `[${placeholder}]`;
    }
  }

  private getTimezone(): string {
    return this.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  }

  private getCustomVariable(name: string): string {
    const customVars = this.context.custom_vars ?? {};
    if (customVars && Object.prototype.hasOwnProperty.call(customVars, name) && customVars[name] !== undefined) {
      return String(customVars[name]);
    }
    const workflowVars = this.context.workflow_vars ?? {};
    if (workflowVars && Object.prototype.hasOwnProperty.call(workflowVars, name) && workflowVars[name] !== undefined) {
      return String(workflowVars[name]);
    }
    return `[var:${name}]`;
  }

  /** Whether a string contains any `[placeholder]` token. */
  static hasPlaceholders(text: string): boolean {
    return /\[[a-zA-Z_][a-zA-Z0-9_:]*\]/.test(text);
  }
}
