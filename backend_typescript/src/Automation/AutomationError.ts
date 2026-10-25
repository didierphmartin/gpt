/** A refused automations operation: its message, HTTP status and error code. Mirrors backend/src/Automation/AutomationError.php. */
export class AutomationError extends Error {
  constructor(message: string, public readonly status: number = 400, public readonly errorCode: string = 'bad_request') {
    super(message);
  }
}
