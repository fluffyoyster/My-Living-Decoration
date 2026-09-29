// Garbage Collector — GLSL. window.GC_SHADERS
// Coordinate space: device pixels, origin top-left, +y down. Monitors are
// vec4(x,y,w,h) in device px. Glyph state lives in G x G float textures.
(function () {
  'use strict';

  const COMMON = `#version 300 es
  precision highp float; precision highp int;
  float hash1(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
  vec2  hash2(vec2 p){ return vec2(hash1(p), hash1(p+19.7)); }
  mat3 rotY(float a){ float c=cos(a),s=sin(a); return mat3(c,0.,-s, 0.,1.,0., s,0.,c); }
  mat3 rotX(float a){ float c=cos(a),s=sin(a); return mat3(1.,0.,0., 0.,c,-s, 0.,s,c); }
  // cheap value-noise gradient -> curl
  float vnoise(vec2 p){
    vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.-2.*f);
    float a=hash1(i), b=hash1(i+vec2(1,0)), c=hash1(i+vec2(0,1)), d=hash1(i+vec2(1,1));
    return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
  }
  vec2 curl(vec2 p){
    float e=0.75;
    float n1=vnoise(p+vec2(0.,e)), n2=vnoise(p-vec2(0.,e));
    float n3=vnoise(p+vec2(e,0.)), n4=vnoise(p-vec2(e,0.));
    return vec2((n1-n2), -(n3-n4))/(2.*e);
  }`;

  // ---- simulation (MRT: pos + vel) ----------------------------------------
  const SIM_FS = COMMON + `
  uniform sampler2D uPos, uVel, uPar, uMeta;
  uniform vec4 uMon[6];
  uniform float uMonSide[6];        // +1 push toward +x (right), -1 toward -x (left)
  uniform int   uMode;              // 0 vortex, 1 flow, 2 objects
  uniform int   uPhase;             // 0 assemble, 1 hold, 2 die
  uniform int   uDeath;             // 0 fall+piston, 1 swallow, 2 shatter
  uniform float uDt, uFormTime, uPhaseT, uSpin;
  uniform float uPourDur, uPourSpeed, uPourDepth, uTubeW, uMouthY;
  uniform float uAssembleLock, uHoldLock;
  uniform float uVortexDepth, uFlowDepth, uFlowScale, uFlowSpeed, uFlowT;
  uniform float uGrav, uTaskbar, uHeap, uPistonStart, uPistonDur, uPush;
  uniform float uSwallow, uExplode, uGravPour, uPistonW;
  layout(location=0) out vec4 outPos;
  layout(location=1) out vec4 outVel;

  void main(){
    ivec2 ij = ivec2(gl_FragCoord.xy);
    vec4 P = texelFetch(uPos, ij, 0);
    vec4 V = texelFetch(uVel, ij, 0);
    vec4 PR= texelFetch(uPar, ij, 0);
    vec4 M = texelFetch(uMeta, ij, 0);
    int mon = int(M.z + 0.5);
    vec4 R = uMon[mon];
    vec2 ctr = R.xy + R.zw*vec2(0.5,0.45);
    float minWH = min(R.z, R.w);
    float off = P.w;
    float act = V.w;
    vec2 hh = hash2(vec2(ij));

    if (off > 0.5) { outPos = P; outVel = V; return; }

    // ---------------- DIE ----------------
    if (uPhase == 2) {
      if (uDeath == 1) {                      // vortex swallow
        vec2 d = ctr - P.xy;
        vec2 nxy = P.xy + d*(1.0-exp(-uDt*2.6));
        vec2 tang = vec2(-d.y, d.x);
        nxy += normalize(tang+1e-4)*length(d)*uSpin*uDt*1.8;
        float nz = P.z + uSwallow*uDt;
        if (nz > uVortexDepth*2.2) off = 1.0;
        outPos = vec4(nxy, nz, off); outVel = V; return;
      } else if (uDeath == 2) {               // shatter
        vec2 dir = normalize(P.xy - ctr + (hh-0.5)*60.0);
        float imp = exp(-uPhaseT*3.5)*uExplode;
        V.xy += dir*imp*uDt*60.0; V.y += uGrav*uDt;
        vec3 np = P.xyz + vec3(V.xy,0.0)*uDt;
        if (np.x<R.x-70.0||np.x>R.x+R.z+70.0||np.y>R.y+R.w+90.0) off=1.0;
        outPos = vec4(np, off); outVel = vec4(V.xyz, act); return;
      } else {                                // fall, then the piston BULLDOZES the pile
        V.y += uGrav*uDt;
        vec3 np = P.xyz + vec3(V.xy,0.0)*uDt;
        float floorY = R.y + R.w - uTaskbar - hh.x*uHeap;
        bool onFloor = false;
        if (np.y > floorY) { np.y = floorY; V.y *= -0.22; V.x *= 0.7; onFloor = true; }
        float t = max(0.0, uPhaseT - uPistonStart);
        float k = clamp(t/uPistonDur, 0.0, 1.0);
        float side = uMonSide[mon];
        float inner = side>0.0 ? R.x        : R.x+R.z;   // blade enters from the inner edge
        float outer = side>0.0 ? R.x+R.z    : R.x;
        float bladeX = mix(inner, outer, k);
        float bladeSpeed = (outer-inner)/max(uPistonDur,0.1);   // px/s, signed toward outer
        float faceX = bladeX + side*(uPistonW*0.5 + 5.0);        // the pushing face
        // if the blade has caught up to this glyph, shove it ahead of the face and kick it up
        if ((np.x - faceX)*side < 0.0) {
          np.x = faceX;                                         // never let the blade pass through
          V.x = side*abs(bladeSpeed)*1.3;                       // ride just ahead -> a pile that rolls along
          V.y = min(V.y, -abs(bladeSpeed)*0.12 - hh.y*40.0);    // gentle tumble, not a rocket
        }
        if (np.x < R.x-45.0 || np.x > R.x+R.z+45.0) off = 1.0;
        outPos = vec4(np, off); outVel = vec4(V.xyz, act); return;
      }
    }

    // ---------------- pour activation ----------------
    // Whole word activates together (same delay from meta.w) and keeps its
    // intact JS-laid position P, so the command reads as a line at the chute.
    float delay = M.w * uPourDur;
    if (act < 0.5) {
      if (uFormTime > delay) {
        act = 1.0;
        V = vec4((hh.x-0.5)*uPourSpeed*0.12, uPourSpeed*0.5, 0.0, act);
      } else {
        outPos = P; outVel = vec4(V.xyz, act); return;
      }
    }

    float since = uFormTime - delay;   // time since this glyph was poured

    // ---------------- flow field ----------------
    // Each glyph starts flowing as soon as IT has settled (since > settle),
    // rather than waiting for the whole formation to reach HOLD.
    if (uMode == 1 && (uPhase == 1 || since > 2.3)) {
      vec2 home = R.xy + (vec2(0.06) + PR.xy*0.88)*R.zw;   // its spot in an even grid-ish spread
      vec2 v = curl(P.xy*uFlowScale + vec2(uFlowT))* uFlowSpeed * (0.5+uSpin);
      v += (home - P.xy) * 0.9;                            // gentle tether: sway on the flow, never migrate/clump
      vec2 np = P.xy + v*uDt;
      np.x = clamp(np.x, R.x-2.0, R.x+R.z+2.0);            // safety clamp, never wraps
      np.y = clamp(np.y, R.y-2.0, R.y+R.w+2.0);
      outPos = vec4(np, P.z, 0.0);
      outVel = vec4(v, 0.0, act); return;
    }

    // ---------------- desired position (vortex / objects / flow-assemble) ----------------
    vec3 desired;
    if (uMode == 0) {                         // vortex / tunnel
      float ang0=PR.x, r=PR.y, swirl=PR.z, spin=PR.w;
      float ang = ang0 + swirl*log(max(r,0.03)) + spin*uSpin*uFormTime*(0.22+0.5/(r+0.25));
      float Rmax = minWH*0.44;
      vec2 xy = ctr + Rmax*r*vec2(cos(ang), sin(ang))*vec2(1.0,0.80);
      desired = vec3(xy, (1.0-r)*uVortexDepth);
    } else if (uMode == 2) {                  // 3D object
      vec3 lp = PR.xyz;
      mat3 rot = rotX(0.42) * rotY(uFormTime*0.5*uSpin);
      vec3 w = rot*lp;
      float s = minWH*0.34;
      desired = vec3(ctr + vec2(w.x, -w.y)*s, w.z*s);   // screen y is down: flip so meshes are upright
    } else {                                  // flow assemble target (matches the tether home)
      desired = vec3(R.xy + (vec2(0.06) + PR.xy*0.88)*R.zw, PR.z*uFlowDepth);
    }

    if (uPhase == 0) {
      // ASSEMBLE: monotonic ease from the chute straight to the final spot.
      // No gravity -> it never sags below the target and springs back up (no "jump").
      // Gentle early, crisp late: the squished word stays readable, then spreads into place.
      float lockA = mix(0.7, uAssembleLock, smoothstep(0.0, 1.8, since));
      vec3 np = mix(P.xyz, desired, 1.0 - exp(-uDt*lockA));
      outPos = vec4(np, 0.0);
      outVel = vec4((np-P.xyz)*0.15/max(uDt,1e-3), act);
      return;
    }
    // HOLD
    vec3 np = mix(P.xyz, desired, 1.0 - exp(-uDt*uHoldLock));
    outPos = vec4(np, 0.0);
    outVel = vec4((np-P.xyz)*0.2/max(uDt,1e-3), act);
  }`;

  // ---- glyph render (instanced) -------------------------------------------
  const GLYPH_VS = COMMON + `
  layout(location=0) in vec2 aCorner;       // [-0.5,0.5]^2
  uniform sampler2D uPos, uVel, uMeta;
  uniform vec4 uMon[6];
  uniform vec3 uSrcCol[9];
  uniform vec2 uRes, uAtlasGrid;
  uniform float uG, uGlyphPx, uCellAspect, uFocal, uGlyphScaleProp;
  out vec2 vUv; out vec3 vCol; out float vBright;
  void main(){
    int id = gl_InstanceID;
    int gi = int(uG+0.5);
    ivec2 ij = ivec2(id % gi, id / gi);
    vec4 P = texelFetch(uPos, ij, 0);
    vec4 V = texelFetch(uVel, ij, 0);
    vec4 M = texelFetch(uMeta, ij, 0);
    if (P.w > 0.5 || V.w < 0.5) { gl_Position = vec4(2.0,2.0,2.0,1.0); return; } // culled
    int mon = int(M.z+0.5);
    vec4 R = uMon[mon];
    vec2 ctr = R.xy + R.zw*vec2(0.5,0.45);
    float persp = uFocal/(uFocal + P.z);   // +z = into the screen: far glyphs shrink toward the vanishing point
    persp = clamp(persp, 0.12, 3.2);
    vec2 screen = ctr + (P.xy - ctr)*persp;
    float sz = uGlyphPx * uGlyphScaleProp * persp * mix(0.82,1.18, hash1(vec2(ij)));
    vec2 corner = aCorner * vec2(sz*uCellAspect, sz);
    // billboard rotation: none (upright text)
    vec2 pos = screen + corner;
    vec2 clip = pos/uRes*2.0 - 1.0; clip.y = -clip.y;
    gl_Position = vec4(clip, 0.0, 1.0);

    float glyph = M.x;
    float cols = uAtlasGrid.x, rows = uAtlasGrid.y;
    float col = mod(glyph, cols), row = floor(glyph/cols);
    vec2 uv0 = vec2(col, row)/uAtlasGrid;
    vUv = uv0 + (aCorner+0.5)/uAtlasGrid;
    vCol = uSrcCol[int(M.y+0.5)];
    vBright = mix(0.30, 1.05, clamp(persp,0.0,1.0));
  }`;

  const GLYPH_FS = `#version 300 es
  precision highp float;
  uniform sampler2D uAtlas; uniform float uGlow;
  in vec2 vUv; in vec3 vCol; in float vBright;
  out vec4 frag;
  void main(){
    float sd = texture(uAtlas, vUv).r;    // 0.5 = edge, <0.5 inside
    float aa = fwidth(sd) + 0.006;
    float core = smoothstep(0.5+aa, 0.5-aa, sd);
    float halo = smoothstep(0.70, 0.5, sd) * 0.34 * uGlow;
    vec3 c = vCol * vBright;
    float a = clamp(core + halo, 0.0, 1.0);
    frag = vec4(c*a, core);              // premultiplied-ish; alpha = core so overlaps read
  }`;

  // ---- bloom --------------------------------------------------------------
  const DOWN_FS = `#version 300 es
  precision highp float; uniform sampler2D uTex; uniform vec2 uTexel; in vec2 vUv; out vec4 frag;
  void main(){
    vec3 s = vec3(0.0);
    s += texture(uTex, vUv+vec2(-1,-1)*uTexel).rgb;
    s += texture(uTex, vUv+vec2( 1,-1)*uTexel).rgb;
    s += texture(uTex, vUv+vec2(-1, 1)*uTexel).rgb;
    s += texture(uTex, vUv+vec2( 1, 1)*uTexel).rgb;
    s *= 0.25;
    float l = max(max(s.r,s.g),s.b);
    frag = vec4(s * smoothstep(0.15,0.5,l), 1.0);
  }`;

  const BLUR_FS = `#version 300 es
  precision highp float; uniform sampler2D uTex; uniform vec2 uDir; in vec2 vUv; out vec4 frag;
  void main(){
    vec3 s = texture(uTex,vUv).rgb*0.227;
    s += texture(uTex, vUv+uDir*1.384).rgb*0.316;
    s += texture(uTex, vUv-uDir*1.384).rgb*0.316;
    s += texture(uTex, vUv+uDir*3.230).rgb*0.070;
    s += texture(uTex, vUv-uDir*3.230).rgb*0.070;
    frag = vec4(s,1.0);
  }`;

  // ---- final composite (bg + scene + bloom + tube + vignette + grain) ------
  const FINAL = `#version 300 es
  precision highp float;
  uniform sampler2D uScene, uBloom;
  uniform vec2 uRes; uniform float uTime, uGlow;
  uniform vec4 uMon[6]; uniform int uNumMon;
  uniform vec3 uClockColor;          // reused as faint tube tint base
  uniform float uTubeY, uTubeVis, uTubeW; uniform vec3 uTubeCol;
  uniform float uTubeX[6];
  uniform float uPistonX[6], uPistonSide[6], uPistonActive, uPistonW, uPistonH, uTaskbar;
  out vec4 frag;
  float box(vec2 p, vec2 b, float r){ vec2 d=abs(p)-b+r; return length(max(d,0.0))+min(max(d.x,d.y),0.0)-r; }
  mat3 mrx(float a){ float c=cos(a),s=sin(a); return mat3(1.,0.,0., 0.,c,-s, 0.,s,c); }
  mat3 mry(float a){ float c=cos(a),s=sin(a); return mat3(c,0.,s, 0.,1.,0., -s,0.,c); }
  float sdBox3(vec3 p, vec3 b, float r){ vec3 d=abs(p)-b; return length(max(d,0.0))+min(max(d.x,max(d.y,d.z)),0.0)-r; }
  void main(){
    vec2 fc = gl_FragCoord.xy;
    vec2 uv = fc/uRes;
    // background: near-black with a very faint cool-neutral vignette per monitor
    vec3 bg = vec3(0.020,0.023,0.030);
    for(int i=0;i<6;i++){ if(i>=uNumMon) break; vec4 R=uMon[i];
      vec2 c=R.xy+R.zw*0.5; vec2 d=(fc-c)/R.zw;
      bg += vec3(0.020,0.024,0.032)*smoothstep(0.75,0.0,length(d));
    }
    vec3 scene = texture(uScene, uv).rgb;
    vec3 bloom = texture(uBloom, uv).rgb * uGlow;
    vec3 col = bg + scene + bloom;

    // physical industrial chute (during pour): opaque dark glass that OCCLUDES,
    // with real shaded metal rings + a bolted flange at the mouth. fc is y-up;
    // monitors are top-down. The pipe starts off-screen above and ends at the mouth.
    if (uTubeVis > 0.001){
      vec2 td = vec2(fc.x, uRes.y - fc.y);
      for(int i=0;i<6;i++){ if(i>=uNumMon) break; vec4 R=uMon[i];
        float tx = uTubeX[i];
        float x  = td.x - tx;
        float hw = uTubeW*0.5;
        float yBot = R.y + uTubeY;              // mouth
        float yTop = R.y - uRes.y;              // far above the top edge (off-screen)
        // flared glass: the half-width grows near the mouth to meet the flange
        float flareLen = min(uTubeY*1.3, hw*1.3);
        float ft = clamp((td.y - (yBot - flareLen))/flareLen, 0.0, 1.0);
        float hwL = hw * mix(1.0, 1.20, smoothstep(0.0,1.0,ft));
        float dxg = abs(x) - hwL;
        float insY = smoothstep(-2.0, 2.0, yBot - td.y);  // 1 above the mouth, soft fade at the mouth
        float inside = smoothstep(1.5,-2.0, dxg) * insY;
        float ax = clamp(abs(x)/hwL, 0.0, 1.0);
        // dark tinted glass, mostly opaque (occludes glyphs behind it), cylinder shaded
        vec3 glass = mix(vec3(0.10,0.115,0.14), vec3(0.02,0.025,0.035), ax*ax);
        col = mix(col, glass, inside*0.92*uTubeVis);
        // specular streak (left) + soft one (right) for wet-glass sheen
        col += vec3(0.55,0.58,0.62)*smoothstep(5.0,0.0,abs(x+hwL*0.5))*inside*0.26*uTubeVis;
        col += vec3(0.30)*smoothstep(4.0,0.0,abs(x-hwL*0.62))*inside*0.12*uTubeVis;
        // bright glass edge
        float rim = (smoothstep(1.5,-1.0, dxg) - smoothstep(-1.0,-4.0, dxg)) * insY;
        col = mix(col, vec3(0.5,0.53,0.58), clamp(rim,0.0,1.0)*0.4*uTubeVis);

        // ---- brushed metal rings (opaque, shaded) ----
        float onX = smoothstep(hw*1.16, hw*1.03, abs(x)) * step(td.y, yBot+1.0);
        float spacing = max(30.0, uTubeY*0.7);
        float m = mod(yBot - td.y, spacing);           // 0 at mouth, repeats up
        float ringTh = 7.0;
        float ring = smoothstep(ringTh, ringTh*0.55, m);
        float lome = 0.20 + 0.7*(0.5+0.5*cos(x/hw*3.14159));   // cylindrical light across width
        vec3 metal = mix(vec3(0.09,0.10,0.12), vec3(0.92,0.94,0.98), lome);
        metal += vec3(0.35)*smoothstep(ringTh*0.45,0.0,abs(m-ringTh*0.32)); // top specular line
        float ringMask = ring*onX*uTubeVis;
        col = mix(col, metal, clamp(ringMask,0.0,1.0));
        col = mix(col, vec3(0.015), smoothstep(1.2,0.0,abs(m-ringTh))*onX*0.7*uTubeVis); // dark seam

        // ---- flange + bolts at the mouth ----
        float onXf = smoothstep(hw*1.24, hw*1.06, abs(x)) * step(td.y, yBot+2.0);
        float flange = smoothstep(ringTh*2.6, ringTh*1.1, abs(td.y - yBot));
        float flMask = flange*onXf*uTubeVis;
        col = mix(col, metal, clamp(flMask,0.0,1.0));
        // bolts: repeating dots along the flange band
        float bx = mod(x + 1000.0, hw*0.5) - hw*0.25;
        float bolt = length(vec2(bx, td.y - (yBot - ringTh*1.6))) - 3.0;
        col = mix(col, vec3(0.02), smoothstep(1.0,-1.0,bolt)*flMask);
        col += vec3(0.4)*smoothstep(0.5,-1.5,bolt+1.5)*flMask*0.5;
      }
    }

    // ---- piston (during DIE): a real raymarched 3D metal ram on the floor ----
    if (uPistonActive > 0.5){
      vec2 td = vec2(fc.x, uRes.y - fc.y);
      for(int i=0;i<6;i++){ if(i>=uNumMon) break; vec4 R=uMon[i];
        float px = uPistonX[i], side = uPistonSide[i];
        float w = uPistonW, bh = uPistonH*1.5;     // bar height
        float mn = min(R.z, R.w);
        vec2 ctrp = R.xy + R.zw*vec2(0.5,0.45);    // the scene's vanishing point for this monitor
        float focal = mn*1.7;                       // SAME camera as the glyphs
        float floorY = R.y + R.w - uTaskbar;
        float topY = floorY - bh;
        float zN = -mn*0.35, zF = mn*0.95;          // bar runs the full depth of the scene
        vec3 bc = vec3(px, (topY+floorY)*0.5, (zN+zF)*0.5);   // box centre (world)
        vec3 bhf = vec3(w*0.5, (floorY-topY)*0.5, (zF-zN)*0.5);
        // reject pixels outside the bar's projected column / above it (perf)
        float xFar = ctrp.x + (px-ctrp.x)*focal/(focal+zF);
        if (td.x < min(px,xFar)-w || td.x > max(px,xFar)+w || td.y < ctrp.y - mn*0.15) continue;
        // scene pinhole camera: origin behind the screen plane, ray through this pixel
        vec3 O = vec3(ctrp, -focal);
        vec3 rd = normalize(vec3(td.x-ctrp.x, td.y-ctrp.y, focal));
        float t=0.0, hit=0.0; vec3 pj;
        for(int s=0;s<80;s++){ pj=O+rd*t; float d=sdBox3(pj-bc, bhf, 5.0); if(d<0.5){hit=1.0;break;} t+=d; if(pj.z>zF+focal+60.0)break; }
        if(hit>0.5){
          vec2 e=vec2(0.8,0.0);
          vec3 n=normalize(vec3(
            sdBox3(pj-bc+e.xyy,bhf,5.0)-sdBox3(pj-bc-e.xyy,bhf,5.0),
            sdBox3(pj-bc+e.yxy,bhf,5.0)-sdBox3(pj-bc-e.yxy,bhf,5.0),
            sdBox3(pj-bc+e.yyx,bhf,5.0)-sdBox3(pj-bc-e.yyx,bhf,5.0)));
          vec3 L=normalize(vec3(-0.4,0.85,-0.35));
          vec3 V=normalize(O-pj), Hh=normalize(L+V);
          float diff=max(dot(n,L),0.0);
          float fill=max(dot(n,V),0.0)*0.4;                 // camera headlight so faces read
          float spec=pow(max(dot(n,Hh),0.0), 50.0);
          float fres=pow(1.0-max(dot(n,V),0.0), 3.0);
          vec3 base=mix(vec3(0.14,0.15,0.18), vec3(0.66,0.70,0.78), 0.5+0.5*n.y);
          col = base*(0.24+0.85*diff+fill) + vec3(1.0)*spec*0.9 + vec3(0.55,0.6,0.68)*fres*0.3;
        }
      }
    }

    // vignette + fine grain (no scanlines)
    float vig = 1.0 - 0.28*pow(length(uv-0.5)*1.25, 2.2);
    col *= vig;
    float g = (fract(sin(dot(fc, vec2(12.9898,78.233)))*43758.5453)-0.5)*0.015;
    col += g;
    frag = vec4(max(col,0.0), 1.0);
  }`;

  window.GC_SHADERS = {
    SIM_FS, GLYPH_VS, GLYPH_FS, DOWN_FS, BLUR_FS, FINAL,
    QUAD_VS: `#version 300 es
      layout(location=0) in vec2 aPos; out vec2 vUv;
      void main(){ vUv=aPos*0.5+0.5; gl_Position=vec4(aPos,0.,1.);} `
  };
})();
