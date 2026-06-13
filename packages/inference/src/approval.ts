/** ToolApprovalRequired moved to @torqclaw/contracts so BOTH inference and the
 *  bridge can throw/catch it without an import cycle (inference depends on
 *  bridge; the error must sit below both). Re-exported here so existing imports
 *  from '@torqclaw/inference' keep working. */
export { ToolApprovalRequired } from '@torqclaw/contracts';
