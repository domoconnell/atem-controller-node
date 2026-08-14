import { config } from './config.js'
import { AtemController } from './atem.js'
import { Animator } from './animator.js'
import { LookStore } from './looks.js'
import { HyperDeck } from './hyperdeck.js'
import { Sequencer } from './sequencer.js'
import { TransitionEngine } from './engine.js'
import { OscServer } from './osc.js'
import { WebServer } from './web.js'

console.log('atem-controller starting')
console.log(`  ATEM      ${config.atem.ip} (main M/E ${config.supersource.me + 1}, SuperSource ${config.supersource.id + 1})`)
console.log(`  HyperDeck ${config.hyperdeck.ip}:${config.hyperdeck.port}`)

const atem = new AtemController()
const animator = new Animator(atem)
const hyperdeck = new HyperDeck()
const looks = new LookStore(atem, hyperdeck)
const engine = new TransitionEngine(atem, hyperdeck)
const sequencer = new Sequencer(atem, animator, looks, hyperdeck, engine)
const oscServer = new OscServer({ atem, animator, looks, sequencer, hyperdeck })
const web = new WebServer({ atem, animator, looks, sequencer, hyperdeck, oscServer, engine })

oscServer.open()
web.start()
hyperdeck.connect()
atem.connect().catch((e) => console.error('[atem] connect failed:', e.message))

process.on('SIGINT', () => {
  console.log('\nshutting down')
  process.exit(0)
})
