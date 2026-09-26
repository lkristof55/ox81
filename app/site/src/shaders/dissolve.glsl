// 3D value noise for the decap dissolve (mould compound eaten by acid). Returns 0..1.
float oxHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float oxNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(oxHash(i + vec3(0, 0, 0)), oxHash(i + vec3(1, 0, 0)), f.x),
                 mix(oxHash(i + vec3(0, 1, 0)), oxHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(oxHash(i + vec3(0, 0, 1)), oxHash(i + vec3(1, 0, 1)), f.x),
                 mix(oxHash(i + vec3(0, 1, 1)), oxHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
