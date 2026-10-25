import { CompiledPackage } from './CompiledPackage';

/**
 * The ADK package's own files: CompiledPackage with ADK's framework packages.
 * Mirrors backend/src/AgentTeam/Services/ADKPackage.php.
 */
export class ADKPackage
{
    static readonly FRAMEWORK: readonly string[] = ['google-adk', 'litellm'];

    static async files(analyzed: any, skillsRoot: string, documentFiles: any = []): Promise<any[]> {
        return CompiledPackage.files(analyzed, skillsRoot, documentFiles, [...ADKPackage.FRAMEWORK], 'Google ADK');
    }

    static codePath(analyzed: any, nid: string): string {
        return CompiledPackage.codePath(analyzed, nid);
    }
}
