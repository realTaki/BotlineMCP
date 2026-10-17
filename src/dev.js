import {configuration} from './config.js';
import http from 'node:http';
import {App,handler} from './app.js';
import {Store} from './store.js';
const config=configuration({...process.env,VERCEL_PROJECT_PRODUCTION_URL:'localhost:3000'});
const store=new Store(config.databaseUrl);await store.initialize();
const serve=handler(new App({store,...config,origin:'http://localhost:3000'}));
http.createServer(serve).listen(3000,'127.0.0.1',()=>console.log('Development server http://localhost:3000'));
