# Skills for Claude Code

Claude Code reads each skill's description at the start of a session and loads
the rest of the skill when a task needs it. These are committed so that every
session, including cloud sessions started from a fresh clone, has them.

| Skill | For | Source |
|---|---|---|
| `rapier-physics` | how this game uses Rapier 0.14, the rules its physics depends on, and how to test a change | written for this project |
| `threejs-materials` | three.js materials, PBR, shader materials | CloudAI-X/threejs-skills |
| `threejs-lighting` | lights, shadows, environment lighting | CloudAI-X/threejs-skills |
| `threejs-shaders` | GLSL, `ShaderMaterial`, uniforms, `onBeforeCompile` | CloudAI-X/threejs-skills |
| `threejs-geometry` | `BufferGeometry`, custom geometry, instancing | CloudAI-X/threejs-skills |

## The three.js skills

Copied from <https://github.com/CloudAI-X/threejs-skills> at commit
`b1c623076c661fc9b03dac19292e825a5d106823`, which its README releases under
the MIT License. Only the four that match what this game draws were taken;
loaders, textures, animation, interaction, post-processing and fundamentals
were left out, since the game loads no models or images and its arm is
simulated, not animated.

Their examples were type-checked against three.js r169, the version this
project uses, and these were changed to match it:

- `threejs-geometry`: the `InstancedBufferGeometry` example shares the base
  geometry's buffers instead of calling `copy()`, which left `instanceCount`
  undefined so nothing drew; and `BufferGeometryUtils.computeTangents()`,
  which r169 doesn't have, is now `geometry.computeTangents()`.
- `threejs-lighting`: the `ContactShadows` example imported a class three.js
  doesn't have (it is from drei, a React library) and is replaced by a pointer
  to the official contact-shadow example; and
  `LightProbeGenerator.fromCubeRenderTarget()` is awaited, since it returns a
  Promise.
- `threejs-shaders`: the WebGL 1 `extensions` flags are replaced by the two
  r169 has; the `output_fragment` include, renamed `opaque_fragment`, is
  corrected; and shader files are imported with Vite's `?raw`.
