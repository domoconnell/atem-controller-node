import { cn } from '@/lib/utils'

/** The Stage It logo, recoloured to the current text colour via a CSS mask so
 *  the (natively dark) artwork shows correctly on the dark UI. `icon` is the
 *  mark; `full` is the wordmark. Set the colour with a text-* class and the
 *  size with width/height classes (sensible defaults per variant). */
export function Brand({ variant = 'icon', className }: { variant?: 'icon' | 'full'; className?: string }) {
  const src = variant === 'full' ? '/brand/full-logo.svg' : '/brand/icon.svg'
  const size = variant === 'full' ? 'h-6 w-[125px]' : 'size-5'
  return (
    <span
      role="img"
      aria-label="Stage It"
      className={cn('inline-block bg-current shrink-0', size, className)}
      style={{
        WebkitMaskImage: `url(${src})`, maskImage: `url(${src})`,
        WebkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat',
        WebkitMaskPosition: 'center', maskPosition: 'center',
        WebkitMaskSize: 'contain', maskSize: 'contain',
      }}
    />
  )
}
