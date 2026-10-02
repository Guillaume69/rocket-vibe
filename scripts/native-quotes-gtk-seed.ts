import {randomUUID} from 'node:crypto';
import {NativeTransport} from '../apps/mobile/fournisseurs/rocketvibe/transport.ts';

const client=new NativeTransport(process.env.RV_PEER_URL!);
await client.login('desktop',process.env.RV_PEER_PASSWORD!);
const name='Native quote composer pilot';
const previous=(await client.snapshot()).rooms.find(room=>room.name===name);
const room=previous??await client.createRoom({operation_id:randomUUID(),name,private:true});
await client.send(room.id,{operation_id:randomUUID(),text:'GTK quote source'});
console.log('Existing GTK quote composer fixture ready');
