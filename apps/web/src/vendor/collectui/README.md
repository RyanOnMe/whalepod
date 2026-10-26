# CollectUI presentation bundle — P1-421 / P1-423 / P1-425 / P1-432 / Motion / P1-437

Twenty-six controlled presentation adaptations: Prompt Input 2, Agent Approval 1, AI Chat 2,
App Sidebar 4, Command Menu 1, App Dialog 6, Empty State 1, Agent Activity 3 and
Tool Calls 2, Card 1, List 7, Comments 1, Settings Form 1, Notifications 4,
Animated List, Modal Cards, Data Table 5, Integrations 1, Card 2 and Monitoring 7, Agent Activity 2, Wizard 1, Tool Calls 5, Card Spread, Depth Card and AI Blob. Inline expansion adapts the fade/slide variant; it
does not reproduce the fullscreen image demo. See
`manifest.json` for source URLs, captured excerpt digests, adapted input digests,
compiler flags and output digests. See `LICENSE.md` for the separate license scope.

The application owns forms, drafts, disabled state, HTTP, approvals, audience
filtering, scrolling, routing and file downloads. Demo timers, fake tokens/model
selectors, sample messages, icon dependencies and Motion have been removed.
Styles use WhalePod's semantic theme tokens; no new runtime dependency is added.
Visible reveals, surface transitions and entry use separate application timing tokens.
Depth Card retains pointer-normalized tilt/spotlight, with a finite velocity-carrying
spring that stops at rest and resets on focus, hidden documents and reduced motion.
Pairing does not infer success from online-device counts; Console does not invent
stdout/stderr or exit codes. Only actual visible artifact counts feed the file fan.

Only minified ES module/CSS and the public slot declarations are distributed.
Editable adaptations and retained source excerpts stay in the ignored
`artifacts/private-ui/collectui/` directory. Keep that directory in authorized
private storage when moving development machines: a public clone can build the
application using committed assets, but cannot regenerate these restricted assets.

An authorized maintainer can regenerate with:

```
node --import tsx apps/web/tools/build-collectui.mts
```

Regenerate both assets and the manifest together. Do not hand-edit generated
assets, add source maps, inline raw JSX, or move restricted originals into fixtures.
The bundle integrity/source-exclusion checks run with the web test suite.

AI Blob retains the mirror's full fragment field and OKLCH ramp; its whitespace-normalized
shader digest is checked before compiling. A native WebGL screen-space pass replaces
Three's scene wrapper, so no new runtime dependency or audio capability is added.
The host passes only a public presentation state and active flag. Four WhalePod
brand tokens feed its colors; thinking, tool and finalizing change the original
mood/field parameters continuously. Approval, synchronization, hidden surfaces and
reduced motion stop the loop. Historical terminal rows use a static marker and no
GPU context. A witnessed live-to-completed change gets one finite contraction.
Context loss provides a branded static/CSS equivalent and restores only the current state.
