import { z } from 'zod'

/**
 * One value a module's config field could sensibly take, as reported by the
 * equipment itself.
 *
 * A **suggestion, never a constraint.** Everything here arrives from a device
 * that happened to be reachable at the moment somebody clicked, and the
 * commonest way this system is configured is the week before load-in with
 * nothing on the network at all. A field offered a list must still accept a
 * name typed from a photograph of a patch sheet — see `WidgetConfigDialog`,
 * where a picker built only from the live frame left an offline module with
 * nothing to choose on the morning of a show, and now carries a guard saying
 * so.
 */
export const configOptionSchema = z.object({
  value: z.string(),
  /** What to show. The bare value when it needs no explaining. */
  label: z.string().optional(),
  /**
   * Narrows this option to one value of another field.
   *
   * Smaart's channels belong to devices, Sennheiser's to receivers: the second
   * list only makes sense once the first is chosen. Expressed as data rather
   * than as a hard-coded pairing in the form, so a connector can declare a
   * dependency the form has never heard of.
   */
  when: z.object({ field: z.string(), equals: z.string() }).optional(),
})
export type ConfigOption = z.infer<typeof configOptionSchema>

/** Options by config field name. A field with nothing to say is simply absent. */
export const configOptionsSchema = z.record(z.string(), z.array(configOptionSchema))
export type ConfigOptions = z.infer<typeof configOptionsSchema>

/**
 * The options to offer for one field, given what the form holds right now.
 *
 * **An unset dependency shows everything**, which is the honest reading rather
 * than a lenient one: leaving Smaart's device name blank means "whichever
 * device it lists first", so a channel list narrowed to nothing would be
 * telling somebody they had no channels when what they had was no preference.
 */
export function optionsFor(
  field: string,
  options: ConfigOptions,
  config: Record<string, unknown>,
): ConfigOption[] {
  return (options[field] ?? []).filter((option) => {
    if (!option.when) return true
    const chosen = config[option.when.field]
    if (typeof chosen !== 'string' || chosen === '') return true
    return chosen === option.when.equals
  })
}
