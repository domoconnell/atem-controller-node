/** Topic grammar (mirrors server/shared/realtime/topics). */
export const buildTopic = (instanceId: string, streamId: string) => `mi:${instanceId}:${streamId}`
export const statusTopic = (instanceId: string) => `mi:${instanceId}:$status`
