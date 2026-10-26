import { CompiledPackage, CompiledTarget } from './CompiledPackage';

/**
 * The ADK package's own files: CompiledPackage with ADK's framework packages.
 * Mirrors backend/src/AgentTeam/Services/ADKPackage.php.
 */
export class ADKPackage
{
    /** google-adk 2.3.x still supports SequentialAgent/ParallelAgent; litellm carries the non-Gemini providers. */
    static readonly FRAMEWORK: readonly string[] = ['google-adk', 'litellm'];

    /** The compile target, as CompiledPackage reads it. */
    static readonly TARGET: CompiledTarget = { key: 'adk', title: 'Google ADK', framework: ADKPackage.FRAMEWORK };

    static async files(analyzed: any, skillsRoot: string, documentFiles: any = [], layout: string = 'modular'): Promise<any[]> {
        return CompiledPackage.files(analyzed, skillsRoot, documentFiles, ADKPackage.TARGET, layout);
    }

    static codePath(analyzed: any, nid: string): string {
        return CompiledPackage.codePath(analyzed, nid);
    }
}
