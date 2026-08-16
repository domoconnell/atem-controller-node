# ProPresenter Creative Countdown Timers — Conversation Summary

## The original problem

The goal is to create a more creatively designed countdown timer in ProPresenter where individual parts of the timer can be styled and positioned independently.

For example, instead of one text object containing:

```text
04:37
```

the desired setup is effectively:

```text
[ 04 ]   [ : ]   [ 37 ]
```

with the minutes and seconds in separate text boxes so they can have different sizes, fonts, positions, animations, etc.

## Native ProPresenter timer formatting limitation

ProPresenter's Linked Text timer formatting does **not** expose the individual components of a duration independently.

When a higher time unit is removed from the timer format, ProPresenter converts that unit into the next lower unit rather than simply hiding it.

For example, if the timer contains:

```text
05:37
```

removing the minutes component does **not** produce:

```text
37
```

Instead, ProPresenter represents the entire remaining duration in seconds:

```text
337
```

The formatter is therefore effectively changing the representation of the complete duration:

```text
01:15:00
1:15:00
75:00
4500
```

rather than exposing values resembling:

```text
timer.hours
timer.minutes
timer.seconds
timer.totalSeconds
```

Consequently, native ProPresenter Linked Text cannot simply bind separate text boxes to the minute and second components of the same timer.

## Why this restricts creative countdown design

This makes sophisticated timer designs unnecessarily difficult. Examples that are not straightforward with the native timer formatter include:

- Minutes and seconds using different fonts or sizes.
- Independently positioned minute and second values.
- Individual digit boxes.
- Rolling or sliding second animations.
- Departure-board-style digit transitions.
- Circular timer progress indicators.
- Progress bars driven by the remaining duration.
- Layout changes during the final minute.
- Special animations during the final ten seconds.

A pre-rendered countdown video can achieve these designs, but it has an important disadvantage: the duration is fixed. A five-minute rendered countdown cannot suddenly become a seven-minute countdown immediately before an event starts.

## Proposed solution: a small HTML countdown renderer

A better approach may be to retain the **actual ProPresenter timer as the source of truth**, while using a small HTML/CSS/JavaScript renderer to display it.

The architecture would be approximately:

```text
ProPresenter Timer
       ↓
ProPresenter API
       ↓
Local HTML/JS Countdown Renderer
       ↓
Custom visual countdown
       ↓
ProPresenter Web Object / Web Source
```

The webpage would read the remaining timer duration and calculate the individual components itself.

For example:

```js
const minutes = Math.floor(totalSeconds / 60);
const seconds = totalSeconds % 60;
```

This gives genuinely independent values:

```text
04
37
```

The HTML could then place them in separate DOM elements and CSS could style and animate each independently.

## It does not need to be an internet-hosted website

The renderer could run entirely locally on the ProPresenter Mac.

For example, a very small Node application could serve something resembling:

```text
http://localhost:3000/countdown
```

Possible structure:

```text
/CountdownRenderer
    server.js
    /public
        countdown.html
        countdown.css
        countdown.js
```

It could potentially support multiple designs or timers through parameters such as:

```text
http://localhost:3000/countdown?style=festival
http://localhost:3000/countdown?style=church
http://localhost:3000/countdown?timer=PreService
```

This means the same underlying system could become a small custom graphics engine rather than merely solving one countdown design.

## ProPresenter would remain in control

The intention is **not** to create a completely separate timer.

ProPresenter should remain the authoritative timer system. Operators would continue to:

- Create the timer in ProPresenter.
- Choose its duration in ProPresenter.
- Start it in ProPresenter.
- Pause it in ProPresenter.
- Reset it in ProPresenter.

The renderer would simply read the current timer state and display it more creatively.

This preserves the operational flexibility of a genuine countdown rather than using a fixed-duration video.

## Potential creative possibilities

Once the timer exists as usable numerical data in JavaScript, the renderer could calculate and display considerably more than minutes and seconds.

Potential values include:

```text
remaining seconds
elapsed seconds
minutes component
seconds component
percentage elapsed
percentage remaining
final-minute state
final-ten-seconds state
```

That enables designs such as:

- Large minutes with smaller seconds.
- Separately animated digits.
- Rolling numbers.
- Countdown progress rings.
- Shrinking progress bars.
- Different layouts at different stages of the countdown.
- A dramatic full-screen final ten seconds.
- An animation or message when the timer reaches zero.

For example:

```text
05
STARTING IN
```

could transition into a normal minute/second display, then at ten seconds change into:

```text
10
9
8
7
...
```

and at zero animate into something such as:

```text
HERE WE GO
```

## The critical requirement: transparency

This approach is only genuinely useful if the HTML renderer can be composited **transparently over ProPresenter's existing backgrounds**.

The desired arrangement is:

```text
ProPresenter Media Layer
        ↓
Animated/video background

Transparent HTML countdown
        ↓
Only timer graphics are visible

Final ProPresenter composition
        ↓
Background + countdown graphics
```

The HTML itself can request a transparent background using CSS:

```css
html,
body {
  background: transparent;
}
```

The important technical question is whether ProPresenter's embedded web renderer preserves that alpha transparency when the webpage is used as a web object/source.

If it does, this becomes a particularly clean solution: the webpage effectively acts as a custom dynamic graphics layer inside ProPresenter while normal ProPresenter backgrounds continue underneath it.

## If native web transparency does not work

There is still a fallback architecture.

The HTML graphics could be rendered externally with alpha and brought into the video system as a **key/fill graphics source**.

That would certainly permit transparent compositing, especially in a system already using DeckLink outputs and key/fill workflows, but it would be considerably more complicated than simply compositing a transparent web object inside ProPresenter.

It should therefore be treated as the fallback rather than the first choice.

## Recommended next test

Before developing the complete countdown system, test whether ProPresenter's web object/source preserves transparency.

Create the simplest possible HTML page containing:

- A transparent HTML/body background.
- One large piece of visible text, such as `TEST`.

Then load that page into ProPresenter over a moving Media Layer background.

If the moving ProPresenter background remains visible everywhere except the rendered `TEST` text, the architecture is viable.

At that point, the next development stages would be:

1. Determine the exact ProPresenter timer API endpoint/data available in the installed ProPresenter version.
2. Read the selected timer from the local renderer.
3. Split the duration into independent components.
4. Build the HTML/CSS graphics system.
5. Add transitions, progress calculations and timer-state-dependent designs.
6. Package the renderer so it starts automatically with the ProPresenter Mac.

## Overall conclusion

ProPresenter's native timer formatting is adequate for conventional countdown displays but does not expose timer components with enough granularity for sophisticated motion/graphic design.

A locally hosted HTML/CSS/JavaScript renderer appears to be a promising way around that limitation while retaining ProPresenter as the timer controller.

The deciding factor is **transparent web compositing inside ProPresenter**. If that works reliably, the result could provide much of the flexibility of a custom broadcast graphics engine while remaining integrated with the existing ProPresenter workflow.
