"""Offline UI checks. Network, authentication, and persistence use in-memory fixtures.

This suite does not replace browser_test.py, which exercises the real HTTP server.
It loads only source files from this repository into an empty browser document.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get("BROWSER_ARTIFACTS", tempfile.mkdtemp(prefix="common-chat-ui-")))
OUT.mkdir(parents=True, exist_ok=True)
html = (ROOT / "public/index.html").read_text()
html = re.sub(r'<link[^>]*>', '', html)
html = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.S)
css = (ROOT / "public/theme.css").read_text() + '\n' + (ROOT / "public/style.css").read_text().replace("@import url('/theme.css');", '')
app = (ROOT / "public/app.js").read_text()
# Resolve ES modules from local files, not the network. The page remains an
# offline in-memory fixture. This does not test the server's CSP.
ASSET_ORIGIN = 'http://common-chat.fixture'
ASSETS = {f'/{name}': ROOT / 'public' / name for name in
          ['markdown.js', 'diagrams.js', 'touch.js', 'vendor/rich-text.js', 'vendor/mermaid.js']}
fixture = r'''
window.__requests = [];
window.__loggedIn = false;
window.__calls = [];
window.__settings = {theme:'dark'};
window.__provider = {id:'provider-1',name:'Local models',baseUrl:'http://model.example/v1',models:['Qwen local','slow'],hasKey:false,capabilities:{streaming:true,vision:true,systemPrompt:true,temperature:true,topP:true,maxTokens:true,tokenParameter:'max_tokens'}};
window.__conversations = [];
window.__counter = 0;
window.__clone = x => JSON.parse(JSON.stringify(x));
window.__notify = value => setTimeout(() => window.__events?.onmessage?.({data:JSON.stringify(value)}), 1);
window.EventSource = class {
  constructor() { window.__events=this;setTimeout(()=>{this.onopen?.();this.onmessage?.({data:JSON.stringify({type:'hello'})});},10); }
  close() {}
};
window.fetch = async (path, options={}) => {
 const method=options.method||'GET',body=options.body?JSON.parse(options.body):{};
 window.__requests.push({path,method,body});
 const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
 const find=id=>window.__conversations.find(c=>c.id===id);
 if(path==='/api/login'){window.__loggedIn=true;return response({authenticated:true});}
 if(path==='/api/session')return window.__loggedIn?response({authenticated:true,settings:window.__settings}):response({error:'Sign in to continue.'},401);
 if(path==='/api/preferences'){Object.assign(window.__settings,body);window.__notify({type:'preferences'});return response(window.__settings);}
 if(path==='/api/providers'&&method==='GET')return response([window.__provider]);
 if(path==='/api/providers'&&method==='POST'){Object.assign(window.__provider,body);return response(window.__provider,201);}
 if(path.startsWith('/api/providers/')&&path.endsWith('/models'))return response({models:window.__provider.models});
 if(path.startsWith('/api/providers/')&&method==='PUT'){Object.assign(window.__provider,body);return response(window.__provider);}
 if(path.startsWith('/api/conversations?'))return response(window.__conversations.map(c=>({id:c.id,title:c.title,version:c.version,running:!!c.activeJob})));
 if(path==='/api/conversations'&&method==='POST'){
   const c={id:'conversation-'+(++window.__counter),title:'New chat',createdAt:Date.now(),updatedAt:Date.now(),activeLeaf:null,activeJob:null,version:1,settings:body.settings||{},messages:[]};window.__conversations.push(c);return response(window.__clone(c),201);
 }
 const match=/^\/api\/conversations\/([^/]+)(?:\/(generate|attachments|export))?$/.exec(path);
 if(match){
   const c=find(match[1]);if(!c)return response({error:'Not found'},404);
   if(!match[2]&&method==='GET')return response(window.__clone(c));
   if(!match[2]&&method==='PATCH'){Object.assign(c,body);c.version++;window.__notify({type:'changed',conversationId:c.id});return response(window.__clone(c));}
   if(match[2]==='generate'){
     let user;
     if(body.regenerate)user=c.messages.find(m=>m.id===body.parentId);
     else{user={id:'message-'+(++window.__counter),conversationId:c.id,parentId:body.parentId,role:'user',content:body.content,reasoning:'',status:'complete',providerId:null,providerName:null,model:null,settings:{},metadata:{},attachments:[],createdAt:Date.now(),updatedAt:Date.now()};c.messages.push(user);}
     const answer={id:'message-'+(++window.__counter),conversationId:c.id,parentId:user.id,role:'assistant',content:'',reasoning:'Compare the options and retain the conversation context.',status:'streaming',providerId:window.__provider.id,providerName:window.__provider.name,model:body.model,settings:body.settings,metadata:{},attachments:[],createdAt:Date.now()+1,updatedAt:Date.now()+1};
     c.messages.push(answer);c.activeLeaf=answer.id;c.version++;c.activeJob={id:'job-'+window.__counter,messageId:answer.id,status:'running'};c.title=user.content.slice(0,65);
     const result={jobId:c.activeJob.id,messageId:answer.id,conversationId:c.id};window.__calls.push({requestId:body.requestId,result});
     setTimeout(()=>{answer.content='The chat interface and the model server can run separately.\n\n## A shared conversation history\n\nYour chat server stores messages, branches, and attachments. Each device reads the same conversation from that server.\n\n- Keep model connections in the server settings.\n- Choose the model for each response.\n- Continue a conversation from another device.\n\n```text\nBrowser  →  Chat server  →  Model endpoint\n                │\n             SQLite\n```\n\nThe original branch remains available when you edit a message or regenerate a response.';answer.status='complete';answer.metadata={usage:{completion_tokens:128},finishReason:'stop'};c.activeJob=null;c.version++;window.__notify({type:'changed',conversationId:c.id});},200);
     window.__notify({type:'changed',conversationId:c.id});return response(result,202);
   }
 }
 if(path.startsWith('/api/requests/')){const r=window.__calls.find(r=>r.requestId===path.split('/').at(-1));return r?response(r.result):response({error:'Not found'},404);}
 throw new Error('Unexpected fixture request: '+method+' '+path);
};
'''
results=[]
with sync_playwright() as p:
    executable=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium')
    browser=p.chromium.launch(headless=True,**({'executable_path':executable} if executable else {}),args=['--no-sandbox'])
    for width,height,label in [(1440,1000,'desktop'),(390,844,'mobile')]:
        context=browser.new_context(viewport={'width':width,'height':height},color_scheme='dark')
        page=context.new_page()
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        def serve_asset(route):
            path = route.request.url.removeprefix(ASSET_ORIGIN).split('?', 1)[0]
            if path not in ASSETS:
                route.abort()
                return
            route.fulfill(body=ASSETS[path].read_bytes(), content_type='text/javascript',
                          headers={'Access-Control-Allow-Origin': '*'})
        page.route(ASSET_ORIGIN + '/**', serve_asset)
        page.set_content(html.replace('<head>', '<head><base href="' + ASSET_ORIGIN + '/">'))
        page.add_style_tag(content=css)
        page.add_script_tag(content=fixture)
        page.add_script_tag(content=app,type='module')
        expect(page.locator('#login-screen')).to_be_visible()
        page.locator('#password').fill('fixture-only-password')
        page.get_by_role('button',name='Sign in',exact=True).click()
        expect(page.locator('#app')).to_be_visible()
        expect(page.locator('#model-input')).to_have_value('Qwen local')
        page.locator('#prompt').fill('How should I separate the chat interface from my model servers?')
        page.get_by_role('button',name='Send',exact=True).click()
        expect(page.locator('article.assistant .message-body').last).to_contain_text('A shared conversation history')
        expect(page.locator('#stop')).to_be_hidden()
        expect(page.locator('#prompt')).to_have_value('')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.screenshot(path=str(OUT/f'{label}.png'),full_page=True)
        results.append({'name':f'{label} sign-in, model selection, chat rendering, draft clearing, and responsive layout','status':'passed','mode':'in-memory fixtures'})
        if label=='desktop':
            page.get_by_role('button',name='Generation settings',exact=True).click()
            page.locator('#temperature').fill('0.4')
            page.locator('#system-prompt').fill('Use clear language.')
            page.get_by_role('button',name='Save settings',exact=True).click()
            expect(page.locator('#generation-dialog')).not_to_be_visible()
            opts=page.evaluate('window.__conversations[0].settings')
            assert opts['temperature']==0.4 and opts['systemPrompt']=='Use clear language.'
            page.get_by_role('button',name='Regenerate',exact=True).click()
            expect(page.locator('#stop')).to_be_hidden()
            page.wait_for_timeout(350)
            assert page.evaluate('window.__conversations[0].messages.length')==3
            page.get_by_role('button',name='Edit',exact=True).click()
            expect(page.locator('#draft-banner')).to_be_visible()
            page.locator('#prompt').fill('Create another branch without removing the original prompt.')
            page.get_by_role('button',name='Send',exact=True).click()
            expect(page.locator('article.user .message-body')).to_contain_text('Create another branch')
            page.wait_for_timeout(350)
            assert page.evaluate('window.__conversations[0].messages.length')==5
            page.get_by_role('button',name='Previous',exact=True).first.click()
            expect(page.locator('article.user .message-body')).to_contain_text('How should I separate')
            results.append({'name':'Generation settings, regeneration, edit branching, and branch selection','status':'passed','mode':'in-memory fixtures'})
            page.get_by_role('button',name='Connections',exact=True).click()
            expect(page.locator('#connection-url')).to_have_value('http://model.example/v1')
            page.locator('#connection-name').fill('Changed connection name')
            page.get_by_role('button',name='Save connection',exact=True).click()
            expect(page.locator('#provider-select')).to_contain_text('Changed connection name')
            results.append({'name':'Connection editing and model selector refresh','status':'passed','mode':'in-memory fixtures'})
        else:
            page.get_by_role('button',name='Open sidebar',exact=True).click()
            expect(page.get_by_role('button',name='Connections',exact=True)).to_be_visible()
            page.get_by_role('button',name='Connections',exact=True).click()
            expect(page.locator('#connections-dialog')).to_be_visible()
            assert page.locator('#connections-dialog').bounding_box()['width']<=width
            results.append({'name':'Mobile sidebar and connection dialog fit the viewport','status':'passed','mode':'in-memory fixtures'})
        assert not errors,errors
        results.append({'name':f'{label} has no JavaScript page errors','status':'passed','mode':'in-memory fixtures'})
        context.close()
    browser.close()
(OUT/'ui-fixture-results.json').write_text(json.dumps({'passed':len(results),'failed':0,'mode':'in-memory fixtures, no HTTP browser navigation','tests':results},indent=2))
print(json.dumps(results,indent=2))
