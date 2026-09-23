import assert from 'node:assert/strict';
import { createServer as createHttpsServer } from 'node:https';
import { request as httpsRequest } from 'node:https';
import { createServer as createTcpServer, type Server } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import type { LookupFunction } from 'node:net';

type Certainty='NOT_DISPATCHED'|'UNKNOWN'|'ACKNOWLEDGED';

interface Attempt {
  certainty:Certainty;
  secure_connected:boolean;
  response_status:number|null;
  error_code:string|null;
}

const KEY=`-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDZUPsn3kwMJ6PT
i3/zvSeO+co3zPmSY/wyumruYbhZ/KAUQkqtnMPCNWjXFromaPRXimfJBQxQLpn8
zMGoT4nvgisHqRlifbAmYOSMwBY+DOemGatfELVCic2tr6kauh0MltoLmcqRuqKK
ukCZUm5bb9k82hxFBXlYv8edN18UCeDp/vuBgfHuCXlDjxE457ivUlCEOoPPZT6Y
Ulye3BQ/2mbnDjknY37mr7f6KXESHKyxTvwFd8+10MNNg56DqXzeeDTRvBDgePU9
C2z45ijO9khATbmxDKNEj+dYwAIVKADF2kdbhDI6AZx0Bu8EWiQVhQnanafCfZYp
R346sGgdAgMBAAECggEATG/u/11x2z6gIZrqJQXN4bzbk1f+Gq8feIpYbUOi78fr
WGTe1oUS1/8oQqtkS3lUJGxyx+KGK7fQgvpUTYq4hi1/TCD+5EU4Ta98BEPWLvok
CqjxvaznTKGi3iowrU10RUbUKAtulGaUoH4VlbhIR9ImE4DWO7LKtVwzbomY4DdZ
GWRg0TvcTrpXoWBolw0E0g/rpJ/a+p/PwsyOvQ0Av+KJpJv7AWdmVCoeJovD79CA
iIAF2TlEiaqy7Ey5n98nZ5mwDFZvxnxSehhlHAdAxIyUSI8HLq52VHBg+268+sVJ
zeq4hBaX+LjfnV5bUJjWswBagCxWRjeRWxCAwCLjowKBgQD5zJ/Bt4QGnLqzjFFW
x0lFDGVpsdZi1xfa9ILnc7/DYkhSj8lcwTSyvZHBv6Rm9PC3ei7/gzg408ylnqGC
Q5MKzi4Bm05wthXpu5El7TSBt8KWnKdkzR+grLNbqgY88rZvkiat1CdmVghwTrGx
Llg3HAbpBd6wwo0yqCA/ddQRRwKBgQDetfDF4nBVeB1McMgK/558h/VZx9dCUfcm
c9jybUk3yOqoO2ufpymbzmbcX321xCq0YvU/jlA0uh9Lu33xzFkQllVBBaiF1F+J
N1aaqnjHHaDRrs6vwmKpknNmJGoa8Q3fJlBC24OCgckA/KXmNT9GbRhzgZKWa2o3
SUWLEXiNewKBgQCEJMA6bQdVrCGEC+2Xd3MGKOmZAS/FN73x4TlCkVPXWy2hJ1lB
TR/AklIB6Yxhvp98oBEur87VGQ4AaytLSs4FgE6MIQlczKZI8CV3p8UH/hrdK9/N
jkl16QY0rnwAT/E8klcNy9ZP56EtMCQF89tMw/HP4YANh83EB3aPu5hEzwKBgQCO
ksUPuZWWca23+N9ngxsPt+4Oyst4Toa9HB6/m8zqpHnstxWAAIC3mNvqqksM6Qc5
sbw1MsMP7jMIxX+sItjFsKflV1z6R+ndKwsLOqTVO5dvhMwWYofM7M9pjVhL5ROv
TpTFKEg5bSKjuhnulRnr2P11PHb+SseVmxelHsshLwKBgGC4Nz8sHxKgWLkV/v2B
ZjmrR42ziLpofNOzwQATuMId7La0+qmd/4zLEbS/guzFLnMsxKtPumCOhoFZ29w7
wY4MArg77xwH/sP+zgtUQx5uNzV/FH1mAA9blp8nx0MQoLOYxGWTKJEIsH7HRcSY
T5fON6xrhaomXfgNi2x8B4EN
-----END PRIVATE KEY-----`;

const CERT=`-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUE2nGRxty7azbIVQcHEXW4A8AA0EwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDkyMzA1NTczOFoXDTM2MDky
MDA1NTczOFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA2VD7J95MDCej04t/870njvnKN8z5kmP8Mrpq7mG4Wfyg
FEJKrZzDwjVo1xa6Jmj0V4pnyQUMUC6Z/MzBqE+J74IrB6kZYn2wJmDkjMAWPgzn
phmrXxC1QonNra+pGrodDJbaC5nKkbqiirpAmVJuW2/ZPNocRQV5WL/HnTdfFAng
6f77gYHx7gl5Q48ROOe4r1JQhDqDz2U+mFJcntwUP9pm5w45J2N+5q+3+ilxEhys
sU78BXfPtdDDTYOeg6l83ng00bwQ4Hj1PQts+OYozvZIQE25sQyjRI/nWMACFSgA
xdpHW4QyOgGcdAbvBFokFYUJ2p2nwn2WKUd+OrBoHQIDAQABo1MwUTAdBgNVHQ4E
FgQU9+jg3avAkItjDUJqR7SJnJ10DqgwHwYDVR0jBBgwFoAU9+jg3avAkItjDUJq
R7SJnJ10DqgwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAnE0b
dQl/jGKbilTwEsOQKDyENDKY49cKhAGGDXxDQIfOEvfoC8DMGxCJ37dEPZnHBOV0
P23fmqVPQQlUTsDvhRn4dS8OADwfZA+VH7O90p+CuO1Tfy2aC+bf1CUBH2bfKu3b
0HLdew+bqLMLcrtuclld+RWc9ym1ioZDHm7fZDOOGQ8FuYKmJtSisvEKHjT2L9EL
sG3crG4X+DxEDyr07XSIRuYRhcvEZ4EYK1Zhlx+mdi1ZRg2zueST8FtJRHwKJiNC
OpuXda4j67y60m0rwSkg5TjdDOv4rHKM5oSqWyo9n+BYhUX2LOvPPQcN0rHo05mI
HG8xElW6gaNx6HGDrw==
-----END CERTIFICATE-----`;

function errorCode(error:unknown):string|null {
  if (!error || typeof error!=='object') return null;
  const code=(error as {code?:unknown}).code;
  return typeof code==='string'?code:null;
}

async function listen(server:Server):Promise<number> {
  return await new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>{
      server.off('error',reject);
      const address=server.address();
      if (!address || typeof address==='string') throw new Error('INVALID_LISTEN_ADDRESS');
      resolve(address.port);
    });
  });
}

async function close(server:Server):Promise<void> {
  await new Promise<void>((resolve,reject)=>{
    server.close(error=>error?reject(error):resolve());
  });
}

async function postWithWitness(
  url:string,
  body:string,
  lookup?:LookupFunction,
):Promise<Attempt> {
  return await new Promise(resolve=>{
    let secureConnected=false;
    let settled=false;
    const finish=(attempt:Attempt):void=>{
      if (settled) return;
      settled=true;
      resolve(attempt);
    };

    const req=httpsRequest(url,{
      method:'POST',
      rejectUnauthorized:false,
      ...(lookup?{lookup}:{}),
      headers:{
        'content-type':'application/json',
        'content-length':Buffer.byteLength(body),
      },
    },response=>{
      response.resume();
      response.once('end',()=>finish({
        certainty:response.statusCode===201?'ACKNOWLEDGED':'UNKNOWN',
        secure_connected:secureConnected,
        response_status:response.statusCode??null,
        error_code:null,
      }));
    });

    req.once('socket',socket=>{
      const tlsSocket=socket as typeof socket & {encrypted?:boolean};
      if (tlsSocket.encrypted && !socket.connecting) secureConnected=true;
      socket.once('secureConnect',()=>{ secureConnected=true; });
    });

    req.once('error',error=>finish({
      certainty:secureConnected?'UNKNOWN':'NOT_DISPATCHED',
      secure_connected:secureConnected,
      response_status:null,
      error_code:errorCode(error),
    }));

    req.end(body);
  });
}

const dnsFailureLookup:LookupFunction=(_hostname,_options,callback)=>{
  const error=Object.assign(new Error('synthetic DNS failure'),{code:'EAI_AGAIN'});
  queueMicrotask(()=>callback(error,undefined as never,undefined as never));
};

const body=JSON.stringify({state:'success',context:'overcenter/proof'});

const dnsFailure=await postWithWitness(
  'https://github.invalid/status',
  body,
  dnsFailureLookup,
);
assert.equal(dnsFailure.certainty,'NOT_DISPATCHED');
assert.equal(dnsFailure.secure_connected,false);

let tlsHandshakePeerBytes=0;
const handshakeReset=createTcpServer(socket=>{
  socket.once('data',chunk=>{
    tlsHandshakePeerBytes+=chunk.length;
    socket.destroy();
  });
});
const handshakePort=await listen(handshakeReset);
const handshakeFailure=await postWithWitness(
  `https://127.0.0.1:${handshakePort}/status`,
  body,
);
await close(handshakeReset);
assert.equal(handshakeFailure.certainty,'NOT_DISPATCHED');
assert.equal(handshakeFailure.secure_connected,false);
assert.ok(tlsHandshakePeerBytes>0,'expected TLS handshake bytes to reach peer');

let postDispatchPeerBytes=0;
const postDispatchReset=createTlsServer({key:KEY,cert:CERT},socket=>{
  socket.once('data',chunk=>{
    postDispatchPeerBytes+=chunk.length;
    socket.destroy();
  });
});
const postDispatchPort=await listen(postDispatchReset);
const postDispatchFailure=await postWithWitness(
  `https://127.0.0.1:${postDispatchPort}/status`,
  body,
);
await close(postDispatchReset);
assert.equal(postDispatchFailure.certainty,'UNKNOWN');
assert.equal(postDispatchFailure.secure_connected,true);
assert.ok(postDispatchPeerBytes>0,'expected decrypted HTTP bytes to reach peer');

let successBody='';
const successServer=createHttpsServer({key:KEY,cert:CERT},(request,response)=>{
  request.setEncoding('utf8');
  request.on('data',chunk=>{ successBody+=chunk; });
  request.on('end',()=>{
    response.writeHead(201,{'content-type':'application/json'});
    response.end('{}');
  });
});
const successPort=await listen(successServer);
const success=await postWithWitness(
  `https://127.0.0.1:${successPort}/status`,
  body,
);
await close(successServer);
assert.equal(success.certainty,'ACKNOWLEDGED');
assert.equal(success.secure_connected,true);
assert.equal(success.response_status,201);
assert.equal(successBody,body);

const unsafeErrorCodePolicyKilled=
  postDispatchFailure.error_code!==null
  && postDispatchPeerBytes>0;
assert.equal(unsafeErrorCodePolicyKilled,true);

const unsafeAnyTransportErrorPolicyKilled=
  postDispatchFailure.certainty==='UNKNOWN'
  && postDispatchPeerBytes>0;
assert.equal(unsafeAnyTransportErrorPolicyKilled,true);

console.log(JSON.stringify({
  experiment:'transport-not-dispatched-evidence',
  result:'SUPPORTED_WITH_NARROW_BOUNDARY',
  cases:{
    dns_failure:{
      ...dnsFailure,
      peer_application_bytes:0,
    },
    tls_handshake_reset:{
      ...handshakeFailure,
      peer_tls_bytes:tlsHandshakePeerBytes,
      peer_application_bytes:0,
    },
    post_secure_connect_reset:{
      ...postDispatchFailure,
      peer_application_bytes:postDispatchPeerBytes,
    },
    acknowledged_201:{
      ...success,
      peer_application_bytes:Buffer.byteLength(successBody),
    },
  },
  invariant:'NOT_DISPATCHED is emitted only before TLS secureConnect on a fresh socket',
  negative_controls:{
    infer_from_error_code_only:'KILLED',
    treat_any_transport_error_as_not_dispatched:'KILLED',
  },
},null,2));
