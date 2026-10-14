/** 提示与提交命令共享现有的验收前置规则；条件只描述当前事实，不授予权限。 */
export function reviewPrerequisiteReason(
  hasActiveRun: boolean,
  hasPublishedArtifact: boolean,
): 'active_run' | 'no_published_artifact' | null {
  if (hasActiveRun) return 'active_run'
  if (!hasPublishedArtifact) return 'no_published_artifact'
  return null
}
