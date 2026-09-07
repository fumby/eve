// Extracted from the approved EVE preview. No dependencies or image textures.
function createEveOrbScene() {
  const TAU = Math.PI * 2;
  const vertexSource = `
    precision highp float;
    attribute vec3 aPosition;
    attribute vec4 aColor;
    attribute vec4 aData;
    uniform mat4 uMvp;
    uniform float uTime, uKind, uDpr, uPointScale, uGain;
    // Her voice. uFlow is the veil's own clock — it runs ahead of uTime while
    // she speaks, so the crests travel faster without a phase jump; uVoice
    // swells them and brightens them; uBass breathes the whole veil out.
    // All three at rest (0, 0, uTime) reproduce the accepted still orb exactly.
    uniform float uVoice, uBass, uFlow;
    varying vec4 vColor;
    varying vec3 vLocal;
    mat2 turn(float t) { float c=cos(t), s=sin(t); return mat2(c,s,-s,c); }
    void main() {
      vec3 p = aPosition;
      float t = uTime;
      float light = 1.0;
      if (uKind > 1.5 && uKind < 3.5) {
        float a = aData.x + t * .055;
        float v = aData.y;
        float phase = aData.z;
        float tw = uFlow;
        float amp = 1.0 + 2.4*uVoice;
        float crest = (.039*sin(3.0*a-tw*.64) + .023*sin(5.0*a+tw*.43+1.4)
                    + .012*sin(9.0*a-tw*.8) + .004*sin(17.0*a+tw*.3)) * amp;
        float width = .093 + .023*sin(4.0*a-tw*.71+1.0);
        float r = .971 + width*cos(v) + crest + .05*uBass;
        float z = .11*sin(v) + .032*sin(3.0*a-tw*.54+v*.8)*amp;
        r += .004*sin(a*73.0 + v*9.0 + tw*.8);
        if (uKind > 2.5) {
          r += .018 + .125*phase + .012*sin(t*.63+phase*50.0) + .08*uVoice*phase;
          z += .09*sin(phase*35.0+t*.24);
        }
        r *= 1.0 + .040*sin(t*1.34-.4);
        p = vec3(r*cos(a),r*sin(a),z);
        light = (.70 + .22*sin(a*5.0-tw*.7+v) + .15*sin(a*13.0+v*4.0+tw*.5)) * (1.0 + .55*uVoice);
        if (uKind > 2.5) light *= .45 + .55*pow(.5+.5*sin(t*1.9+phase*65.0),2.0);
      } else if (uKind < .5 || (uKind > 4.5 && uKind < 5.5)) {
        p.xz = turn(t*.18+.3)*p.xz;
        p.yz = turn(.13)*p.yz;
        p *= 1.0 + .045*sin(t*1.34);
        light = .42 + .58*smoothstep(-.12,.38,p.z);
      } else if (uKind < 1.5) {
        p.xy = turn(t*aData.x+aData.y)*p.xy;
        p *= 1.0+.035*sin(t*1.34-.2);
        light = .78 + .22*sin(atan(p.y,p.x)*2.0-t*.9+aData.z);
      } else if (uKind > 3.5 && uKind < 4.5) {
        p *= 1.0 + .045*sin(t*1.34);
      }
      vLocal = p;
      vColor = vec4(aColor.rgb, aColor.a * light * uGain);
      gl_Position = uMvp * vec4(p,1.0);
      gl_PointSize = max(1.0,aData.w * uDpr * uPointScale);
    }
  `;
  const fragmentSource = `
    precision highp float;
    uniform float uPointMode, uKind;
    varying vec4 vColor;
    varying vec3 vLocal;
    void main() {
      vec4 col = vColor;
      if (uPointMode > .5) {
        float d=length(gl_PointCoord-vec2(.5))*2.0;
        if (d>1.0) discard;
        col.a *= exp(-d*d*3.0)*(1.0-smoothstep(.65,1.0,d));
      }
      if (uKind > 4.5 && uKind < 5.5) {
        float rim=pow(1.0-abs(normalize(vLocal).z),3.0);
        col=vec4(vec3(.002,.027,.033)+vec3(.0,.025,.03)*rim,1.0);
      }
      if (uKind > .5 && uKind < 1.5) {
        float a=atan(vLocal.y,vLocal.x);
        float patches=pow(max(0.0,sin(a+.18)),8.0)*1.25 + pow(max(0.0,cos(a+2.50)),10.0)*.8;
        col.rgb *= .72+patches;
      }
      if (uKind > 6.5) {
        float r=length(vLocal.xy);
        float a=exp(-pow((r-.96)/.13,2.0))*.09 + exp(-r*r*2.7)*.018;
        col=vec4(.0,.44,.48,a);
      }
      gl_FragColor=col;
    }
  `;
  const meshes = [];
  function mesh(name, mode, kind, options={}) {
    const m={name,mode,kind,depthTest:false,depthWrite:false,blend:'add',positions:[],colors:[],data:[],...options}; meshes.push(m); return m;
  }
  function vertex(m,p,c,d=[0,0,0,1]) { m.positions.push(...p);m.colors.push(...c);m.data.push(...d); }
  function line(m,a,b,c,d=[0,0,0,1]) { vertex(m,a,c,d);vertex(m,b,c,d); }
  function tri(m,a,b,c,color,d=[0,0,0,1]) { vertex(m,a,color,d);vertex(m,b,color,d);vertex(m,c,color,d); }
  const polar=(a,r,z=0)=>[r*Math.cos(a),r*Math.sin(a),z];

  const haze=mesh('localized radiance',4,7);
  tri(haze,[-1.5,-1.5,-.2],[1.5,-1.5,-.2],[1.5,1.5,-.2],[0,.3,.3,.1]);
  tri(haze,[-1.5,-1.5,-.2],[1.5,1.5,-.2],[-1.5,1.5,-.2],[0,.3,.3,.1]);

  // Three concentric annuli, with actual thickness on the broad blue panels.
  function band(name,inner,outer,count,speed,baseColor,z,depth,gap) {
    const m=mesh(name,4,1);
    for(let i=0;i<count;i++) {
      const d=[speed,.06,i*.23,1];
      const strength=.64+.36*Math.pow(.5+.5*Math.cos(i*.19),3);
      const col=[...baseColor, strength];
      const back=[baseColor[0]*.42,baseColor[1]*.50,baseColor[2]*.56,.6];
      const begin=TAU*i/count+gap, end=TAU*(i+1)/count-gap;
      const steps=4;
      for(let j=0;j<steps;j++) {
        const a=begin+(end-begin)*j/steps, b=begin+(end-begin)*(j+1)/steps;
        const p=polar(a,inner,z),q=polar(b,inner,z),r=polar(b,outer,z),s=polar(a,outer,z);
        // The cyan outward edge of each block catches light.
        vertex(m,p,[col[0]*.65,col[1]*.64,col[2]*.68,col[3]],d);vertex(m,q,[col[0]*.65,col[1]*.64,col[2]*.68,col[3]],d);vertex(m,r,col,d);
        vertex(m,p,[col[0]*.65,col[1]*.64,col[2]*.68,col[3]],d);vertex(m,r,col,d);vertex(m,s,col,d);
        if(depth) {const rb=polar(b,outer,z-depth),sb=polar(a,outer,z-depth);tri(m,s,r,rb,back,d);tri(m,s,rb,sb,back,d);}
      }
      if(depth) {
        for(const a of [begin,end]) {
          const p=polar(a,inner,z),q=polar(a,outer,z),r=polar(a,outer,z-depth),s=polar(a,inner,z-depth);
          tri(m,p,q,r,back,d);tri(m,p,r,s,back,d);
        }
      }
    }
    return m;
  }
  band('recessed inner circuitry',.47,.525,54,-.062,[.009,.070,.082],-.03,.015,.019);
  band('broad radial blue panels',.625,.785,68,.034,[.017,.29,.37],.005,.052,.0048);
  band('narrow teal segmented crown',.842,.873,110,-.043,[.021,.40,.40],.028,.014,.0028);
  const spill=mesh('light between panel layers',0,1);
  for(let i=0;i<640;i++) {
    const a=i*TAU/640;
    const r=.769+.028*Math.sin(i*7.37);
    vertex(spill,polar(a,r,.03),[.025,.53,.55,.055],[.034,.06,0,9+3*Math.cos(i*4.13)]);
  }
  const tracks=mesh('circular machined tracks',1,1);
  for(const [radius,alpha] of [[.591,.12],[.617,.23],[.800,.21],[.824,.13],[.885,.27]]) {
    for(let i=0;i<720;i++) line(tracks,polar(i*TAU/720,radius,-.008),polar((i+1)*TAU/720,radius,-.008),[.025,.6,.63,alpha],[.017,0,0,1]);
  }
  const graduations=mesh('fine radial graduations',1,1);
  for(let i=0;i<320;i++) {
    const a=i*TAU/320;
    line(graduations,polar(a,.813),polar(a,.824+(i%5===0?.012:0)),[.05,.69,.68,i%5===0?.28:.12],[-.031,0,0,1]);
  }

  // A dense deforming toroidal membrane, built from particles and continuous filaments.
  const cloth=mesh('flowing particle membrane',0,2,{glow:true});
  const filaments=mesh('translucent veil filaments',1,2);
  const boundary=mesh('undulating luminous hems',1,2);
  const baseMembrane=(a,v)=>polar(a,.971+.09*Math.cos(v),.11*Math.sin(v));
  let seed=739391;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  for(let j=0;j<58;j++) {
    const v=j*TAU/58;
    for(let i=0;i<768;i++) {
      const a=(i+(j%2)*.5)*TAU/768;
      const jitter=(random()-.5)*.045;
      const shade=.55+random()*.45;
      vertex(cloth,baseMembrane(a,v),[.050,.76,.74, .65*shade],[a,v+jitter,random(),.90+random()*.57]);
      if(j%2===0) {
        const b=a+TAU/768;
        vertex(filaments,baseMembrane(a,v),[.028,.61,.61,.105],[a,v,0,1]);
        vertex(filaments,baseMembrane(b,v),[.028,.61,.61,.105],[b,v,0,1]);
      }
    }
  }
  for(const v of [.02, .16, Math.PI-.04, Math.PI+.10]) {
    for(let i=0;i<1400;i++) {
      for(const a of [TAU*i/1400,TAU*(i+1)/1400]) vertex(boundary,baseMembrane(a,v),[.08,.84,.80,v<1?.46:.34],[a,v,0,1]);
    }
  }
  const dust=mesh('drifting edge dust',0,3,{glow:true});
  for(let i=0;i<6200;i++) {
    const a=random()*TAU,v=random()*TAU,seed=random();
    vertex(dust,baseMembrane(a,v),[.035,.63,.63,.12+random()*.35],[a,v,seed,.55+random()*.85]);
  }

  // Subdivided icosahedron: uniform triangular topology, no painted wire pattern.
  const coreSurface=mesh('opaque spherical core',4,5,{depthTest:true,depthWrite:true,blend:'none'});
  const core=mesh('triangulated rotating globe',1,0,{depthTest:true,depthWrite:false});
  const golden=(1+Math.sqrt(5))/2;
  const normal=p=>{const l=Math.hypot(...p);return p.map(x=>x/l);};
  let vertices=[[-1,golden,0],[1,golden,0],[-1,-golden,0],[1,-golden,0],[0,-1,golden],[0,1,golden],[0,-1,-golden],[0,1,-golden],[golden,0,-1],[golden,0,1],[-golden,0,-1],[-golden,0,1]].map(normal);
  let faces=[[0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],[1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],[3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],[4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]];
  for(let n=0;n<3;n++) {
    const mids=new Map();
    function middle(a,b) {const key=a<b?a+','+b:b+','+a;if(mids.has(key))return mids.get(key);const id=vertices.length;vertices.push(normal(vertices[a].map((x,i)=>(x+vertices[b][i])*.5)));mids.set(key,id);return id;}
    faces=faces.flatMap(([a,b,c])=>{const ab=middle(a,b),bc=middle(b,c),ca=middle(c,a);return [[a,ab,ca],[b,bc,ab],[c,ca,bc],[ab,bc,ca]];});
  }
  const edges=new Set();
  for(const [a,b,c] of faces) {
    tri(coreSurface,vertices[a].map(x=>x*.403),vertices[b].map(x=>x*.403),vertices[c].map(x=>x*.403),[.001,.02,.025,1]);
    for(const [p,q] of [[a,b],[b,c],[c,a]]) {const key=p<q?p+','+q:q+','+p;if(edges.has(key))continue;edges.add(key);line(core,vertices[p].map(x=>x*.407),vertices[q].map(x=>x*.407),[.63,.94,.87,.79]);}
  }
  const contour=mesh('thin luminous core contour',4,4);
  for(let i=0;i<900;i++) {
    const a=i*TAU/900,b=(i+1)*TAU/900;
    const p=polar(a,.406,.008),q=polar(b,.406,.008),r=polar(b,.412,.008),s=polar(a,.412,.008);
    tri(contour,p,q,r,[.72,1,.94,.95]);tri(contour,p,r,s,[.72,1,.94,.95]);
  }

  const mul=(a,b)=>{const o=new Array(16).fill(0);for(let c=0;c<4;c++)for(let r=0;r<4;r++)for(let k=0;k<4;k++)o[c*4+r]+=a[k*4+r]*b[c*4+k];return o;};
  function model(t,core=false) {
    const x=core?0:-.055+Math.sin(t*.21)*.018;
    const y=core?0:.025*Math.sin(t*.17);
    const cx=Math.cos(x),sx=Math.sin(x),cy=Math.cos(y),sy=Math.sin(y);
    return mul([1,0,0,0,0,1,0,0,0,0,1,0,0,0,-4,1],mul([cy,0,-sy,0,0,1,0,0,sy,0,cy,0,0,0,0,1],[1,0,0,0,0,cx,sx,0,0,-sx,cx,0,0,0,0,1]));
  }
  // The build-up. `reveal` runs 0→1 over the first seconds after mount and
  // each layer fades up inside its own window, inside out: the globe first,
  // then its contour, the three bands, the tracks, the veil, and last the
  // dust and the radiance — she assembles rather than appears. The globe
  // and the contour overshoot a little (a flash as they ignite); everything
  // sits at exactly 1 once reveal reaches 1, so the accepted orb is untouched.
  const REVEAL={
    'opaque spherical core':[0,.18],'triangulated rotating globe':[.02,.26],'thin luminous core contour':[.14,.32],
    'recessed inner circuitry':[.22,.42],'broad radial blue panels':[.30,.52],'narrow teal segmented crown':[.38,.58],
    'circular machined tracks':[.42,.62],'fine radial graduations':[.46,.66],'light between panel layers':[.50,.70],
    'undulating luminous hems':[.56,.80],'translucent veil filaments':[.60,.86],'flowing particle membrane':[.62,.92],
    'drifting edge dust':[.72,1],'localized radiance':[.66,1],
  };
  const IGNITE=new Set(['triangulated rotating globe','thin luminous core contour']);
  const smooth=(e0,e1,x)=>{const t=Math.min(1,Math.max(0,(x-e0)/(e1-e0)));return t*t*(3-2*t);};
  function revealGain(name,reveal) {
    if(reveal>=1)return 1;
    const [s0,s1]=REVEAL[name]||[0,1];
    const g=smooth(s0,s1,reveal);
    return IGNITE.has(name)?g*(1+.9*Math.sin(g*Math.PI)):g;
  }
  const scaleMat=(s)=>[s,0,0,0,0,s,0,0,0,0,s,0,0,0,0,1];
  /** One frame's draw list. `opts`: reveal 0..1 (build-up progress, default
   *  1 = fully formed), voice/bass 0..1 (her speech, default silent), flow
   *  (the veil's clock, default = time). Defaults reproduce the accepted orb. */
  function frame(time,width,height,dpr=1,opts={}) {
    const reveal=opts.reveal===undefined?1:Math.min(1,Math.max(0,opts.reveal));
    const voice=Math.min(1,Math.max(0,opts.voice||0)),bass=Math.min(1,Math.max(0,opts.bass||0));
    const flow=opts.flow===undefined?time:opts.flow;
    const aspect=width/height;
    const f=1/Math.tan(.66/2),near=.1,far=20;
    const proj=[f/aspect,0,0,0,0,f,0,0,0,0,(far+near)/(near-far),-1,0,0,2*far*near/(near-far),0];
    // The assembly grows from a little over half size while it forms.
    const grow=reveal>=1?1:.55+.45*(1-Math.pow(1-Math.min(1,reveal/.6),3));
    const S=scaleMat(grow);
    const matrices=[mul(proj,mul(model(time),S)),mul(proj,mul(model(time,true),S))];
    const draws=[];
    for(const m of meshes) {
      const g=revealGain(m.name,reveal);
      const base={...m,matrix:matrices[m.kind===0||m.kind===4||m.kind===5?1:0],uniforms:{uTime:time,uKind:m.kind,uDpr:dpr,uPointMode:m.mode===0?1:0,uPointScale:1,uGain:g,uVoice:voice,uBass:bass,uFlow:flow}};
      if(m.glow)draws.push({...base,uniforms:{...base.uniforms,uPointScale:4.2,uGain:.045*g}});
      draws.push(base);
    }
    return {vertexSource,fragmentSource,width,height,time,draws};
  }
  return {vertexSource,fragmentSource,meshes,frame,revealGain};
}

/** Mount the renderer on `canvas`, once, for the life of the page.
 *  opts.intro (default true): play the build-up on mount — INTRO_MS of her
 *  assembling, inside out. Pass false under reduced motion. */
const INTRO_MS=2600;
function mountOrb(canvas,opts={}) {
  const scene=createEveOrbScene();
  const intro=opts.intro!==false;
  const gl=canvas.getContext('webgl',{alpha:false,antialias:true,depth:true,powerPreference:'low-power'});
  const notice=canvas.parentElement.querySelector('.eve-orb-error');
  const fail=message=>{canvas.hidden=true;if(notice){notice.hidden=false;notice.textContent=message;}return {setVisible(){},setLevelSource(){},destroy(){}};};
  if(!gl)return fail('The 3D view needs WebGL to display.');
  let program,shaders=[],buffers=[],frameId=0,visible=true,dead=false,lost=false;
  try {
    program=gl.createProgram();
    for(const [type,source] of [[gl.VERTEX_SHADER,scene.vertexSource],[gl.FRAGMENT_SHADER,scene.fragmentSource]]) {
      const s=gl.createShader(type);shaders.push(s);gl.shaderSource(s,source);gl.compileShader(s);
      if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));gl.attachShader(program,s);
    }
    gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
  } catch(error) {console.error('EVE orb renderer:',error);shaders.forEach(s=>gl.deleteShader(s));if(program)gl.deleteProgram(program);return fail('The 3D view could not initialize.');}
  const attrs=['aPosition','aColor','aData'].map(name=>gl.getAttribLocation(program,name));
  const uniforms=Object.fromEntries(['uMvp','uTime','uKind','uDpr','uPointMode','uPointScale','uGain','uVoice','uBass','uFlow'].map(name=>[name,gl.getUniformLocation(program,name)]));
  const gpu=new Map();
  for(const m of scene.meshes) {
    const b=[m.positions,m.colors,m.data].map(values=>{const b=gl.createBuffer();buffers.push(b);gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(values),gl.STATIC_DRAW);return b;});gpu.set(m.name,b);
  }
  const origin=performance.now();
  // Her voice, read each frame from whatever analyser the face hands us
  // ({loud, bass, live, playing} — see audio.js). Real levels when they
  // flow; when audio is playing but can't be analysed (the element
  // fallback), a speech-shaped synthetic envelope, so she still moves with
  // her words. Fast attack, slow release: a syllable lands at once and
  // ebbs, instead of flickering. `flow` is the veil's clock — it runs up to
  // four times faster than the wall clock while she speaks.
  let levelSource=null,voice=0,bass=0,flow=0,lastFrame=0;
  const approach=(cur,target,k,dt)=>cur+(target-cur)*(1-Math.exp(-k*dt));
  function voiceStep(time,dt) {
    let raw=null;
    try{raw=levelSource?levelSource():null;}catch{raw=null;}
    let loud=0,low=0;
    if(raw&&raw.live){loud=+raw.loud||0;low=+raw.bass||0;}
    else if(raw&&raw.playing){const e=.28+.3*Math.sin(time*6.1)+.2*Math.sin(time*13.7+1)+.15*Math.sin(time*2.3);loud=Math.min(1,Math.max(0,e));low=loud*.6;}
    voice=approach(voice,Math.min(1,Math.max(0,loud)),loud>voice?18:4,dt);
    bass=approach(bass,Math.min(1,Math.max(0,low)),low>bass?14:3,dt);
    flow+=dt*(1+3*voice);
  }
  // Layout size, never getBoundingClientRect: the face moves and shrinks her
  // with a CSS transform (the Quiet→Working flight, the small Working pose),
  // and a transformed rect would re-allocate the drawing buffer on every frame
  // of that flight — and draw the small orb small, which is a different orb
  // (the particle veil is sized in device pixels). clientWidth ignores
  // transforms, so she is always drawn at her Quiet size and only scaled.
  const resize=()=>{const cw=canvas.clientWidth,ch=canvas.clientHeight;if(cw<1||ch<1)return;const dpr=Math.min(devicePixelRatio||1,2);const w=Math.round(cw*dpr),h=Math.round(ch*dpr);if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}gl.viewport(0,0,w,h);};
  const observer=new ResizeObserver(resize);observer.observe(canvas);
  function draw(now) {
    frameId=0;if(dead||lost||!visible||document.hidden)return;
    if(!canvas.isConnected){destroy();return;}
    resize();gl.useProgram(program);gl.clearColor(0,0,0,1);gl.depthMask(true);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    const dpr=Math.min(devicePixelRatio||1,2),time=(now-origin)/1000;
    const dt=Math.min(.05,Math.max(0,lastFrame?(now-lastFrame)/1000:1/60));lastFrame=now;
    voiceStep(time,dt);
    const reveal=intro?Math.min(1,(now-origin)/INTRO_MS):1;
    const current=scene.frame(time,canvas.width,canvas.height,dpr,{reveal,voice,bass,flow});
    for(const m of current.draws) {
      const bs=gpu.get(m.name);for(let i=0;i<3;i++){gl.bindBuffer(gl.ARRAY_BUFFER,bs[i]);gl.enableVertexAttribArray(attrs[i]);gl.vertexAttribPointer(attrs[i],i===0?3:4,gl.FLOAT,false,0,0);}
      if(m.depthTest)gl.enable(gl.DEPTH_TEST);else gl.disable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.depthMask(Boolean(m.depthWrite));
      if(m.blend==='none')gl.disable(gl.BLEND);else{gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE);}
      gl.uniformMatrix4fv(uniforms.uMvp,false,new Float32Array(m.matrix));for(const [key,value] of Object.entries(m.uniforms))gl.uniform1f(uniforms[key],value);
      gl.drawArrays(m.mode,0,m.positions.length/3);
    }
    frameId=requestAnimationFrame(draw);
  }
  function start(){if(visible&&!dead&&!lost&&!document.hidden&&!frameId)frameId=requestAnimationFrame(draw);}
  function onVisibility(){if(document.hidden){cancelAnimationFrame(frameId);frameId=0;}else start();}
  const lifetime=new MutationObserver(()=>{if(!canvas.isConnected)destroy();});
  lifetime.observe(document.documentElement,{childList:true,subtree:true});
  function destroy(){if(dead)return;dead=true;cancelAnimationFrame(frameId);observer.disconnect();lifetime.disconnect();document.removeEventListener('visibilitychange',onVisibility);buffers.forEach(b=>gl.deleteBuffer(b));shaders.forEach(s=>gl.deleteShader(s));gl.deleteProgram(program);}
  document.addEventListener('visibilitychange',onVisibility);
  canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();lost=true;cancelAnimationFrame(frameId);frameId=0;if(notice){notice.hidden=false;notice.textContent='The 3D view was interrupted. Reopen this preview to restore it.';}},{once:true});
  resize();start();
  return {
    setVisible(v){visible=v;if(!v){cancelAnimationFrame(frameId);frameId=0;}else{lastFrame=0;start();}},
    /** fn() → {loud, bass, live, playing} | null, polled every frame. */
    setLevelSource(fn){levelSource=typeof fn==='function'?fn:null;},
    destroy,
  };
}

export { createEveOrbScene, mountOrb };
