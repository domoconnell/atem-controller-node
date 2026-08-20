import { z } from 'zod'
import { underThreshold } from '../core/hysteresis.js'
import type { ConditionDecl } from '../core/types.js'
import type { ChannelReading } from './protocol.js'

/**
 * The canonical warnings-only module: a rack of twelve receivers where eleven
 * are fine, and the operator wants the two that are not.
 *
 * Every condition reports per channel, so a widget in problems-only mode shows
 * exactly the packs that need attention.
 */
export const sennheiserConditions: readonly ConditionDecl[] = [
  {
    id: 'battery.low',
    label: 'Transmitter battery low',
    description: 'A linked transmitter is below the charge threshold.',
    streamId: 'channels',
    paramsSchema: z.object({ pct: z.number().min(1).max(100) }),
    // 25% is roughly a set's worth of margin on a typical pack.
    defaultParams: { pct: 25 },
    defaultSeverity: 'warning',
    evaluate: (payload, params, wasActive) => {
      const channels = (payload as { channels?: ChannelReading[] }).channels ?? []
      const { pct } = params as { pct: number }

      return channels.map((channel) => ({
        itemKey: channel.channel,
        itemLabel: channel.name ?? `Ch ${channel.channel}`,
        // An unlinked channel has no transmitter to have a flat battery.
        active:
          channel.linked &&
          channel.batteryPct !== null &&
          underThreshold(channel.batteryPct, pct, wasActive?.(channel.channel) ?? false),
        value: channel.batteryPct ?? 0,
        detail:
          channel.batteryRuntimeMin !== null
            ? `${channel.batteryPct}% · ~${channel.batteryRuntimeMin} min left`
            : `${channel.batteryPct}%`,
      }))
    },
  },
  {
    id: 'rf.low',
    label: 'RF quality poor',
    // RSQI is Sennheiser's own 1–5 link-quality figure and is a better
    // predictor of a dropout than a raw dBm level.
    description: 'Link quality (RSQI) has dropped below the threshold.',
    streamId: 'channels',
    paramsSchema: z.object({ rsqi: z.number().min(1).max(5) }),
    defaultParams: { rsqi: 3 },
    defaultSeverity: 'warning',
    evaluate: (payload, params, wasActive) => {
      const channels = (payload as { channels?: ChannelReading[] }).channels ?? []
      const { rsqi } = params as { rsqi: number }

      return channels.map((channel) => ({
        itemKey: channel.channel,
        itemLabel: channel.name ?? `Ch ${channel.channel}`,
        active:
          channel.linked &&
          channel.rsqi !== null &&
          underThreshold(channel.rsqi, rsqi, wasActive?.(channel.channel) ?? false),
        value: channel.rsqi ?? 0,
        detail: `RSQI ${channel.rsqi}${channel.rfLevelDbm !== null ? ` · ${channel.rfLevelDbm} dBm` : ''}`,
      }))
    },
  },
  {
    id: 'channel.unlinked',
    label: 'No transmitter',
    description: 'A receiver channel has no transmitter linked to it.',
    streamId: 'channels',
    paramsSchema: z.object({}).strict(),
    defaultParams: {},
    defaultSeverity: 'info',
    evaluate: (payload) => {
      const channels = (payload as { channels?: ChannelReading[] }).channels ?? []
      return channels.map((channel) => ({
        itemKey: channel.channel,
        itemLabel: channel.name ?? `Ch ${channel.channel}`,
        active: !channel.linked,
        value: channel.linked ? 'linked' : 'no transmitter',
        detail: channel.linked ? undefined : 'Transmitter off or out of range',
      }))
    },
  },
  {
    id: 'channel.muted',
    label: 'Channel muted',
    description: 'A receiver channel is muted.',
    streamId: 'channels',
    paramsSchema: z.object({}).strict(),
    defaultParams: {},
    defaultSeverity: 'info',
    evaluate: (payload) => {
      const channels = (payload as { channels?: ChannelReading[] }).channels ?? []
      return channels
        .filter((channel) => channel.linked)
        .map((channel) => ({
          itemKey: channel.channel,
          itemLabel: channel.name ?? `Ch ${channel.channel}`,
          active: channel.muted === true,
          value: channel.muted ? 'muted' : 'live',
        }))
    },
  },
]
