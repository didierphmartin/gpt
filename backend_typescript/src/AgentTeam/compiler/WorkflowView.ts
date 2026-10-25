import { stdObj } from './php';

/**
 * The workflow as the compiler reads it: the getters PHP's Models\Workflow offers ($facts['workflow']->...),
 * over the TypeScript Workflow record (WorkflowRepository) or the fields the PHP parity harness prints.
 */
export class WorkflowView {
  constructor(
    private readonly id: number | null,
    private readonly name: string,
    private readonly outputStorageEnabled: boolean,
    private readonly outputFolder: string | null,
    private readonly orchestration: string,
  ) {}

  /** From the TypeScript Workflow record (WorkflowRepository.findById). */
  static fromModel(w: { id: number | null; name: string; outputStorageEnabled: any; outputFolder: string | null; orchestration: string }): WorkflowView {
    return new WorkflowView(w.id, w.name ?? '', !!w.outputStorageEnabled, w.outputFolder ?? null, w.orchestration ?? 'workflow');
  }

  /** From {id, name, output_storage_enabled, output_folder, orchestration} (a record, e.g. the PHP harness's facts). */
  static fromRecord(r: any): WorkflowView {
    const o = String(r?.orchestration ?? 'workflow');
    return new WorkflowView(
      r?.id ?? null,
      String(r?.name ?? ''),
      !!r?.output_storage_enabled,
      r?.output_folder ?? null,
      o === 'workflow' || o === 'swarm' ? o : 'workflow',
    );
  }

  getId(): number | null {
    return this.id;
  }

  getName(): string {
    return this.name;
  }

  isOutputStorageEnabled(): boolean {
    return this.outputStorageEnabled;
  }

  getOutputFolder(): string | null {
    return this.outputFolder;
  }

  getOrchestration(): string {
    return this.orchestration;
  }

  /** json_encode of the PHP object: its fields are private, so {}. */
  toJSON(): Record<string, never> {
    return stdObj({});
  }
}
