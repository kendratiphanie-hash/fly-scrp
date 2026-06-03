require('dotenv').config();
const { Client, GatewayIntentBits, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const express = require('express');

const CONFIG = {
    PORT: process.env.PORT || 3000,
    MAX_FILE_SIZE: 512000,
    MAX_OUTPUT_SIZE: 12582912,
};

// ═══════════════════════════════════════════════════════════════
// SEEDED RNG — xoshiro128**
// ═══════════════════════════════════════════════════════════════
class SeededRandom {
    constructor(seed) {
        seed = seed >>> 0;
        const sm = (s) => { s=(s^(s>>>16))*0x45d9f3b; s=(s^(s>>>16))*0x45d9f3b; return (s^(s>>>16))>>>0; };
        this.state = new Uint32Array([sm(seed),sm(seed+1),sm(seed+2),sm(seed+3)]);
    }
    next() {
        const r = Math.imul(this.state[1]*5,(this.state[1]*5<<7)|(this.state[1]*5>>>25))>>>0;
        const t = (this.state[1]<<9)>>>0;
        this.state[2]^=this.state[0]; this.state[3]^=this.state[1];
        this.state[1]^=this.state[2]; this.state[0]^=this.state[3];
        this.state[2]^=t; this.state[3]=((this.state[3]<<11)|(this.state[3]>>>21))>>>0;
        return r;
    }
    nextFloat() { return (this.next()>>>5)*(1.0/134217728.0); }
    nextRange(min,max) { return min+Math.floor(this.nextFloat()*(max-min)); }
    nextByte() { return this.next()%256; }
    shuffle(arr) {
        for (let i=arr.length-1;i>0;i--) {
            const j=this.nextRange(0,i+1);
            [arr[i],arr[j]]=[arr[j],arr[i]];
        }
        return arr;
    }
}

// ═══════════════════════════════════════════════════════════════
// NAME GENERATOR — short cycling names a,b,c...aa,ab...
// ═══════════════════════════════════════════════════════════════
const LUA_KEYWORDS = new Set([
    'and','break','do','else','elseif','end','false','for','function',
    'if','in','local','nil','not','or','repeat','return','then','true','until','while'
]);

class NameGen {
    constructor(rng) { this.rng=rng; this.counter=0; this.used=new Set(); }
    next() {
        let name;
        do {
            let n=this.counter++; let s='';
            do { s=String.fromCharCode(97+(n%26))+s; n=Math.floor(n/26)-1; } while(n>=0);
            name=s;
        } while(this.used.has(name)||LUA_KEYWORDS.has(name));
        this.used.add(name);
        return name;
    }
    batch(n) { return Array.from({length:n},()=>this.next()); }
}

// ═══════════════════════════════════════════════════════════════
// ENCRYPTION — XOR + bit rotation, bit32 only (Roblox-safe)
// ═══════════════════════════════════════════════════════════════
class Crypto {
    constructor(rng) {
        this.parts = Array.from({length:4},()=>Array.from({length:8},()=>rng.nextByte()));
        this.key   = this.parts.flat();
        this.rotKey= Array.from({length:16},()=>rng.nextRange(1,7));
    }
    encrypt(str) {
        let out = Array.from(Buffer.from(str,'utf8')).map((b,i)=>b^this.key[i%this.key.length]);
        return out.map((b,i)=>{ const r=this.rotKey[i%this.rotKey.length]; return (((b<<r)|(b>>>(8-r)))&0xFF); });
    }
    emitKeySetup(ng) {
        const pv=ng.batch(4),fv=ng.next(),iv=ng.batch(4),p=[];
        this.parts.forEach((pt,i)=>p.push(`local ${pv[i]}={${pt.join(',')}}`));
        p.push(`local ${fv}={}`);
        pv.forEach((v,i)=>p.push(`for ${iv[i]}=1,#${v} do ${fv}[#${fv}+1]=${v}[${iv[i]}] end`));
        return {code:p.join(';'),fullVar:fv};
    }
    emitRotKeySetup(ng) {
        const v=ng.next();
        return {code:`local ${v}={${this.rotKey.join(',')}}`,rotVar:v};
    }
    emitDecryptFn(ng,fullVar,rotVar) {
        const fn=ng.next(),[i,b,r,res]=ng.batch(4);
        const code=`local ${fn}=function(enc,key,rk) local ${res}={};for ${i}=1,#enc do local ${b}=enc[${i}];local ${r}=rk[(${i}-1)%#rk+1];${b}=bit32.band(bit32.bor(bit32.rshift(${b},(8-${r})),bit32.lshift(${b},${r})),0xFF);${b}=bit32.bxor(${b},key[(${i}-1)%#key+1]);${res}[${i}]=string.char(${b}) end;return table.concat(${res}) end`;
        return {code,fnVar:fn};
    }
}

// ═══════════════════════════════════════════════════════════════
// CONSTANT POOL — escaped string blob format
// ═══════════════════════════════════════════════════════════════
class ConstantPool {
    constructor(rng,crypto) { this.rng=rng; this.crypto=crypto; this.entries=[]; }
    add(str) {
        this.entries.push({bytes:this.crypto.encrypt(str)});
        return this.entries.length-1;
    }
    emitPool(ng) {
        const pv=ng.next(),parts=[`local ${pv}={}`];
        this.entries.forEach((e,idx)=>{
            const sv=ng.next(),iv=ng.next(),tv=ng.next();
            const esc=e.bytes.map(b=>`\\${b}`).join('');
            parts.push(`local ${sv}="${esc}"`);
            parts.push(`local ${tv}={}`);
            parts.push(`for ${iv}=1,#${sv} do ${tv}[${iv}]=string.byte(${sv},${iv}) end`);
            parts.push(`${pv}[${idx+1}]=${tv}`);
        });
        return {code:parts.join(';'),poolVar:pv};
    }
}

// ═══════════════════════════════════════════════════════════════
// FULL VM COMPILER — 17 real opcodes + 16 decoys
//
// Real opcodes:
//   LOAD_CONST  reg[A] = decrypt(pool[B])
//   LOAD_NIL    reg[A] = nil
//   LOAD_BOOL   reg[A] = (B~=0)
//   LOAD_INT    reg[A] = B
//   MOVE        reg[A] = reg[B]
//   ADD         reg[A] = reg[B] + reg[C]
//   SUB         reg[A] = reg[B] - reg[C]
//   MUL         reg[A] = reg[B] * reg[C]
//   DIV         reg[A] = reg[B] / reg[C]
//   MOD         reg[A] = reg[B] % reg[C]
//   CONCAT      reg[A] = reg[B] .. reg[C]
//   UNM         reg[A] = -reg[B]
//   NOT         reg[A] = not reg[B]
//   TEST        if reg[A] truth ~= (B~=0) then skip next
//   JMP         pc += B
//   CALL        C==0: load(reg[B])+pcall  C==1: #tostring(reg[B])
//   RETURN      terminate
//
// All opcode IDs randomly remapped per session.
// All Lua emitted uses bit32.* only — Roblox-safe.
// ═══════════════════════════════════════════════════════════════
class VMCompiler {
    constructor(rng,ng) {
        this.rng=rng; this.ng=ng;
        this.REAL_OPS=[
            'LOAD_CONST','LOAD_NIL','LOAD_BOOL','LOAD_INT',
            'MOVE','ADD','SUB','MUL','DIV','MOD','CONCAT',
            'UNM','NOT','TEST','JMP','CALL','RETURN'
        ];
        this.DECOY_OPS=Array.from({length:16},(_,i)=>`DX${String(i).padStart(2,'0')}`);
        this.opcodeMap=this._buildOpcodeMap();
    }

    _buildOpcodeMap() {
        const all=[...this.REAL_OPS,...this.DECOY_OPS];
        const vals=all.map((_,i)=>i);
        this.rng.shuffle(vals);
        const map={};
        all.forEach((op,i)=>{ map[op]=vals[i]; });
        return map;
    }

    // Compiles source into a realistic multi-instruction sequence.
    // The source is encrypted into pool[0]. Surrounding instructions
    // (arithmetic, moves, tests, jumps) make the execution path
    // non-trivial to trace statically without understanding the full ISA.
    compile(source,pool) {
        const ops=this.opcodeMap;
        const idx=pool.add(source);
        return [
            [ops.LOAD_NIL,    0, 0, 0],  // reg[0] = nil sentinel
            [ops.LOAD_BOOL,   1, 1, 0],  // reg[1] = true (live flag)
            [ops.LOAD_INT,    2,32, 0],  // reg[2] = 32 (version watermark)
            [ops.LOAD_CONST,  3,idx,0],  // reg[3] = decrypted source string
            [ops.MOVE,        4, 3, 0],  // reg[4] = reg[3] (copy, adds indirection)
            [ops.CALL,        5, 4, 1],  // reg[5] = string length of reg[4] (noise)
            [ops.ADD,         6, 5, 2],  // reg[6] = reg[5] + reg[2] (noise arithmetic)
            [ops.MOD,         7, 6, 2],  // reg[7] = reg[6] % reg[2] (noise)
            [ops.TEST,        1, 1, 0],  // if reg[1] truth ~= true → skip (never fires)
            [ops.JMP,         0, 2, 0],  // jump +2 (dead branch, never reached)
            [ops.CALL,        8, 4, 0],  // execute reg[4] via load()+pcall (real exec)
            [ops.RETURN,      0, 0, 0],  // terminate
        ];
    }

    _decoyHandlers(ng,regVar,pcVar,instrVar) {
        const ops=this.opcodeMap;
        return this.DECOY_OPS.map(key=>{
            const [a,b]=ng.batch(2);
            const n=this.rng.nextRange(1,99);
            return `[${ops[key]}]=function(A,B,C) local ${a}=${regVar}[1] and ${n} or ${pcVar};if ${a}~=${a} then ${pcVar}=#${instrVar} end end`;
        }).join(',');
    }

    emitVM(ng,decFnVar,poolVar,keyVar,rotVar,instructions) {
        const ops=this.opcodeMap;
        const [
            regVar,instrVar,pcVar,dispVar,
            loadAliasVar,srcVar,fnVar,okVar,errVar,
            opVar,aVar,bVar,cVar,execVar
        ]=ng.batch(14);

        const serialized=instructions.map(([op,a,b,c])=>`{${op},${a},${b},${c}}`).join(',');
        const decoyH=this._decoyHandlers(ng,regVar,pcVar,instrVar);

        const realH=[
            `[${ops.LOAD_CONST}]=function(A,B,C) ${regVar}[A]=${decFnVar}(${poolVar}[B+1],${keyVar},${rotVar}) end`,
            `[${ops.LOAD_NIL}]=function(A,B,C) ${regVar}[A]=nil end`,
            `[${ops.LOAD_BOOL}]=function(A,B,C) ${regVar}[A]=(B~=0) end`,
            `[${ops.LOAD_INT}]=function(A,B,C) ${regVar}[A]=B end`,
            `[${ops.MOVE}]=function(A,B,C) ${regVar}[A]=${regVar}[B] end`,
            `[${ops.ADD}]=function(A,B,C) ${regVar}[A]=(${regVar}[B] or 0)+(${regVar}[C] or 0) end`,
            `[${ops.SUB}]=function(A,B,C) ${regVar}[A]=(${regVar}[B] or 0)-(${regVar}[C] or 0) end`,
            `[${ops.MUL}]=function(A,B,C) ${regVar}[A]=(${regVar}[B] or 0)*(${regVar}[C] or 0) end`,
            `[${ops.DIV}]=function(A,B,C) local d=${regVar}[C] or 0;${regVar}[A]=(d~=0) and (${regVar}[B] or 0)/d or 0 end`,
            `[${ops.MOD}]=function(A,B,C) local d=${regVar}[C] or 0;${regVar}[A]=(d~=0) and (${regVar}[B] or 0)%d or 0 end`,
            `[${ops.CONCAT}]=function(A,B,C) ${regVar}[A]=tostring(${regVar}[B] or "")..tostring(${regVar}[C] or "") end`,
            `[${ops.UNM}]=function(A,B,C) ${regVar}[A]=-(${regVar}[B] or 0) end`,
            `[${ops.NOT}]=function(A,B,C) ${regVar}[A]=not ${regVar}[B] end`,
            `[${ops.TEST}]=function(A,B,C) if(not not ${regVar}[A])~=(B~=0) then ${pcVar}=${pcVar}+1 end end`,
            `[${ops.JMP}]=function(A,B,C) ${pcVar}=${pcVar}+B end`,
            `[${ops.CALL}]=function(A,B,C) if C==1 then ${regVar}[A]=#tostring(${regVar}[B] or "") else local ${srcVar}=${regVar}[B];local ${fnVar},${errVar}=(loadstring or load)(${srcVar});if not ${fnVar} then error("[XORA] compile: "..(${errVar} or "?"),0) end;local ${okVar};${okVar},${errVar}=pcall(${fnVar});if not ${okVar} then error("[XORA] runtime: "..(${errVar} or "?"),0) end end end`,
            `[${ops.RETURN}]=function(A,B,C) ${pcVar}=#${instrVar}+1 end`,
        ].join(',');

        return [
            `local ${regVar}={}`,
            `local ${instrVar}={${serialized}}`,
            `local ${pcVar}=1`,
            `local ${dispVar}={${realH},${decoyH}}`,
            `while ${pcVar}<=#${instrVar} do local ${opVar}=${instrVar}[${pcVar}][1];local ${aVar}=${instrVar}[${pcVar}][2];local ${bVar}=${instrVar}[${pcVar}][3];local ${cVar}=${instrVar}[${pcVar}][4];${pcVar}=${pcVar}+1;local ${execVar}=${dispVar}[${opVar}];if ${execVar} then ${execVar}(${aVar},${bVar},${cVar}) end end`,
        ].join(';');
    }
}

// ═══════════════════════════════════════════════════════════════
// JUNK CODE GENERATOR — 12 patterns, inlined do..end
// ═══════════════════════════════════════════════════════════════
class JunkGen {
    constructor(rng,ng) { this.rng=rng; this.ng=ng; }
    line() {
        const r=this.rng.next()%12;
        const [a,b,c,d]=this.ng.batch(4);
        const n1=this.rng.nextRange(2,30),n2=this.rng.nextRange(1,8);
        const str=this.rng.next().toString(36).slice(0,4);
        switch(r){
            case 0:  return `local ${a}=false;if ${a} then for ${b}=1,${n1} do ${a}=${b}*${b} end end`;
            case 1:  return `local ${a}=setmetatable({},{__index=function(_,${b})return ${b} end})`;
            case 2:  return `local ${a}=(function(${b}) return ${b}*${b}>0 end)(${n1})`;
            case 3:  return `local ${a}=string.rep("${str}",${n2}):len()`;
            case 4:  return `local ${a}=0;for ${b}=${n1},${n1*3} do ${a}=${a}+${b} end`;
            case 5:  return `local ${a}=type(nil);if ${a}~="nil" then ${a}=1 end`;
            case 6:  return `local ${a}=bit32 and bit32.bxor(${n1},${n2}) or ${n1}`;
            case 7:  return `local ${a}=(function() local ${b}={};for ${c}=1,${n2} do ${b}[${c}]=${c}*${n1} end;return #${b} end)()`;
            case 8:  return `local ${a},${b}=pcall(function() return math.sqrt(${n1}) end)`;
            case 9:  return `local ${a}=type(rawget)=="function" and 1 or 0`;
            case 10: return `local ${a}=string.byte("${str}",1,#"${str}")`;
            case 11: return `local ${a}={[${n1}]="${str}",[${n2}]=${n1}*${n2}};${a}=nil`;
            default: return `local ${a}=0`;
        }
    }
    block(count) { return `do `+Array.from({length:count},()=>this.line()).join(';')+` end`; }
}

// ═══════════════════════════════════════════════════════════════
// CONTROL FLOW FLATTENING — 2-level, semicolon-collapsed
// ═══════════════════════════════════════════════════════════════
class CFGFlattener {
    constructor(rng,ng) { this.rng=rng; this.ng=ng; }
    flatten(blocks,junkGen,junkPerBlock=3) {
        const ids=Array.from({length:blocks.length},()=>this.rng.nextRange(100,9999));
        const used=new Set(ids);
        for(let i=0;i<ids.length;i++) while(used.size<(i+1)) ids[i]++;
        const order=[...Array(blocks.length).keys()];
        this.rng.shuffle(order);
        const [dv,sv,tv]=this.ng.batch(3);
        let out=`local ${sv}=${ids[0]};local ${dv}={};`;
        for(const idx of order){
            const next=(idx+1<blocks.length)?ids[idx+1]:-1;
            const junk=junkGen.block(junkPerBlock).replace(/\n/g,';');
            const blk=blocks[idx].replace(/\n/g,';');
            out+=`${dv}[${ids[idx]}]=function() ${junk};${blk};${sv}=${next} end;`;
        }
        out+=`while ${sv}~=-1 do local ${tv}=${dv}[${sv}];if ${tv} then ${tv}() else break end end`;
        return out;
    }
}

// ═══════════════════════════════════════════════════════════════
// XORA v4 — Full VM Edition
// ═══════════════════════════════════════════════════════════════
class XORAv4 {
    constructor(seed=null) {
        this.seed    = seed||Math.floor(Math.random()*0x7FFFFFFF);
        this.rng     = new SeededRandom(this.seed);
        this.ng      = new NameGen(this.rng);
        this.crypto  = new Crypto(this.rng);
        this.pool    = new ConstantPool(this.rng,this.crypto);
        this.junk    = new JunkGen(this.rng,this.ng);
        this.flatter = new CFGFlattener(this.rng,this.ng);
        this.vm      = new VMCompiler(this.rng,this.ng);
    }

    obfuscate(source) {
        if(!source||source.length===0) throw new Error('Empty source');

        const instructions = this.vm.compile(source,this.pool);

        const {code:keyCode,fullVar:keyVar} = this.crypto.emitKeySetup(this.ng);
        const {code:rotCode,rotVar}          = this.crypto.emitRotKeySetup(this.ng);
        const {code:decCode,fnVar:decFnVar}  = this.crypto.emitDecryptFn(this.ng,keyVar,rotVar);
        const {code:poolCode,poolVar}        = this.pool.emitPool(this.ng);

        const setupBlocks=[
            keyCode, rotCode,
            this.junk.block(10),
            poolCode,
            this.junk.block(8),
            decCode,
            this.junk.block(6),
        ];

        const flatSetup = this.flatter.flatten(setupBlocks,this.junk,4);
        const vmCode    = this.vm.emitVM(this.ng,decFnVar,poolVar,keyVar,rotVar,instructions);
        const vmFlat    = this.flatter.flatten([vmCode],this.junk,5);
        const pre       = this.junk.block(15);

        const output=[this.banner(), pre+';'+flatSetup+';'+vmFlat].join('\n');
        if(output.length>CONFIG.MAX_OUTPUT_SIZE) throw new Error('Output too large');
        return output;
    }

    banner() {
        return `--[[
 ██╗  ██╗ ██████╗ ██████╗  █████╗     ██╗   ██╗██╗  ██╗
 ╚██╗██╔╝██╔═══██╗██╔══██╗██╔══██╗    ██║   ██║██║  ██║
  ╚███╔╝ ██║   ██║██████╔╝███████║    ██║   ██║███████║
  ██╔██╗ ██║   ██║██╔══██╗██╔══██║    ╚██╗ ██╔╝╚════██║
 ██╔╝ ██╗╚██████╔╝██║  ██║██║  ██║     ╚████╔╝      ██║
 ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝     ╚═══╝       ╚═╝
  XORA v4.0 — Full VM Edition
  Seed: 0x${this.seed.toString(16).padStart(8,'0')}
  VM:   17 real opcodes + 16 decoys (33 total, all remapped per session)
        LOAD_CONST LOAD_NIL LOAD_BOOL LOAD_INT MOVE
        ADD SUB MUL DIV MOD CONCAT UNM NOT TEST JMP CALL RETURN
  Output: Short names (a,b,c..) • Escaped blob pool • 2-level CFG
          Semicolon-collapsed • bit32-only • Roblox Script/LocalScript/ModuleScript
]]--`;
    }
}

// ═══════════════════════════════════════════════════════════════
// EXPRESS SERVER
// ═══════════════════════════════════════════════════════════════
const app = express();
app.get('/',(req,res)=>res.status(200).json({status:'online',version:'4.0.0',mode:'XORA v4 Full VM'}));
app.get('/health',(req,res)=>res.status(200).send('OK'));
app.listen(CONFIG.PORT,()=>console.log(`[XORA v4] Running on port ${CONFIG.PORT}`));

// ═══════════════════════════════════════════════════════════════
// DISCORD BOT
// ═══════════════════════════════════════════════════════════════
const client = new Client({
    intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent]
});

client.once('ready',c=>{
    console.log(`✅ ${c.user.tag} online — XORA v4 Full VM`);
    c.user.setActivity('!obfuscate | XORA v4');
});

client.on('messageCreate',async message=>{
    if(message.author.bot) return;

    if(message.content==='!help'){
        const embed=new EmbedBuilder()
            .setTitle('XORA v4.0 — Full VM Edition')
            .setColor(0x5865F2)
            .setDescription('Roblox Lua/LuaU obfuscation — full multi-opcode VM, blob output.')
            .addFields(
                {name:'!obfuscate',value:'Attach a .lua or .luau file',inline:false},
                {name:'VM Opcodes (17 real)',value:[
                    '`LOAD_CONST` `LOAD_NIL` `LOAD_BOOL` `LOAD_INT` `MOVE`',
                    '`ADD` `SUB` `MUL` `DIV` `MOD` `CONCAT`',
                    '`UNM` `NOT` `TEST` `JMP` `CALL` `RETURN`',
                    '+ 16 decoy handlers — all 33 slots remapped per session',
                ].join('\n'),inline:false},
                {name:'Protection Layers',value:[
                    '🖥️ Full register-based VM (17 real opcodes, 16 decoys)',
                    '🔀 Per-session opcode shuffle — IDs never the same twice',
                    '🔑 32-byte XOR+Rot key, split across 4 tables',
                    '📦 Escaped string blob pool (\\NNN format)',
                    '🌀 2-level CFG flattening, semicolon-collapsed',
                    '🗑️ 12-pattern junk in do..end one-liners',
                    '🔤 Short cycling names: a, b, c ... aa, ab ...',
                    '✅ bit32-only — Roblox Script/LocalScript/ModuleScript',
                ].join('\n'),inline:false}
            );
        return message.reply({embeds:[embed]});
    }

    if(message.content==='!info'){
        const embed=new EmbedBuilder()
            .setTitle('XORA v4.0 Architecture')
            .setColor(0x57F287)
            .addFields(
                {name:'RNG',       value:'xoshiro128** + splitmix32 seeding',inline:false},
                {name:'Names',     value:'Short cycling: a, b, c ... aa, ab ...',inline:false},
                {name:'VM',        value:'17 real opcodes + 16 decoy handlers = 33 total slots, all randomly remapped per session',inline:false},
                {name:'ISA',       value:'LOAD_CONST LOAD_NIL LOAD_BOOL LOAD_INT MOVE ADD SUB MUL DIV MOD CONCAT UNM NOT TEST JMP CALL RETURN',inline:false},
                {name:'Execution', value:'CALL opcode (C=0) triggers load()+pcall — execution buried inside VM dispatch loop',inline:false},
                {name:'Key',       value:'32-byte key (4x8 parts) + 16-byte rotation key',inline:false},
                {name:'Encrypt',   value:'Two-pass: XOR via bit32.bxor, bit-rotate via bit32.lshift/rshift/band/bor',inline:false},
                {name:'Pool',      value:'Escaped string blob "\\NNN..." converted via string.byte at runtime',inline:false},
                {name:'CFG',       value:'2-level state machine, fully semicolon-collapsed',inline:false},
                {name:'Junk',      value:'12 patterns, do..end one-liners at 4 injection points',inline:false},
                {name:'Roblox',    value:'✅ bit32, pcall, load(), string.*, table.*, math.* only. No LuaU-only ops.',inline:false}
            );
        return message.reply({embeds:[embed]});
    }

    if(message.content.startsWith('!obfuscate')){
        const attachment=message.attachments.first();
        if(!attachment) return message.reply('❌ Attach a .lua or .luau file');
        if(!attachment.name.endsWith('.lua')&&!attachment.name.endsWith('.luau'))
            return message.reply('❌ Only .lua and .luau files supported');
        if(attachment.size===0) return message.reply('❌ File is empty');
        if(attachment.size>CONFIG.MAX_FILE_SIZE)
            return message.reply(`❌ File too large. Max: ${CONFIG.MAX_FILE_SIZE/1024}KB`);

        const status=await message.reply('⏳ Obfuscating with XORA v4 Full VM...');

        try {
            const res=await fetch(attachment.url);
            if(!res.ok) throw new Error(`Fetch failed: ${res.statusText}`);
            const source=await res.text();
            if(!source||source.length===0) throw new Error('File is empty');

            const engine    =new XORAv4();
            const start     =Date.now();
            const obfuscated=engine.obfuscate(source);
            const elapsed   =Date.now()-start;

            const buffer=Buffer.from(obfuscated,'utf-8');
            if(buffer.length>CONFIG.MAX_OUTPUT_SIZE) throw new Error('Output too large');

            const file=new AttachmentBuilder(buffer,{name:`xora_v4_${attachment.name}`});
            const ratio=((buffer.length/attachment.size)*100).toFixed(1);

            const embed=new EmbedBuilder()
                .setTitle('✅ XORA v4.0 Obfuscation Complete')
                .setColor(0x57F287)
                .addFields(
                    {name:'Input',     value:`${attachment.size.toLocaleString()} bytes`,inline:true},
                    {name:'Output',    value:`${buffer.length.toLocaleString()} bytes`,  inline:true},
                    {name:'Expansion', value:`${ratio}%`,                                inline:true},
                    {name:'Time',      value:`${elapsed}ms`,                             inline:true},
                    {name:'Seed',      value:`0x${engine.seed.toString(16)}`,            inline:true},
                    {name:'Roblox',    value:'✅ Compatible',                             inline:true},
                    {name:'VM',        value:`17 real opcodes + 16 decoys, remapped per session`,inline:false},
                    {name:'Key',       value:`32-byte XOR+Rot, split 4 tables`,          inline:false},
                    {name:'Style',     value:'Full VM • Blob pool • Short names • 2-line output',inline:false}
                )
                .setFooter({text:'XORA v4.0 — Full VM Edition'});

            await status.delete();
            await message.reply({embeds:[embed],files:[file]});

        } catch(err){
            console.error('[XORA v4] Error:',err);
            try { await status.edit(`❌ ${err.message.slice(0,100)}`); }
            catch { await message.reply(`❌ Failed: ${err.message.slice(0,100)}`); }
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
