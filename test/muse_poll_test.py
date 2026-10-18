import contextlib
import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location('muse_poll', Path(__file__).parents[1] / 'clients/muse/muse-poll.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class Inbox:
    def __init__(self, count):
        self.messages = [{'message_id': f'msg_{i}', 'text': 'synthetic'} for i in range(count)]
        self.calls = []
    def call_tool(self, name, args):
        self.calls.append((name, dict(args)))
        if name == 'messages_ack':
            self.messages = [x for x in self.messages if x['message_id'] not in args['message_ids']]
            return {'acknowledged': args['message_ids']}
        if name == 'messages_send':
            return {'message_id': 'synthetic', 'request_id': args['request_id']}
        start = args.get('cursor', 0)
        limit = args.get('limit', 50)
        page = self.messages[start:start+limit]
        return {'messages': page, 'next_cursor': start+limit if start+limit < len(self.messages) else None}

def poll(client, limit=0):
    out=io.StringIO()
    with contextlib.redirect_stdout(out):
        m.cmd_poll(client, SimpleNamespace(token='synthetic', limit=limit))
    return json.loads(out.getvalue())

class PollTests(unittest.TestCase):
    def test_unacked_messages_survive_worker_crash(self):
        c=Inbox(51)
        first=poll(c)
        self.assertEqual(len(first), 51)
        self.assertEqual(poll(c), first)  # no ACK: repeat after a worker crash
        c.call_tool('messages_ack', {'message_ids': [x['message_id'] for x in first[:20]]})
        self.assertEqual(poll(c), first[20:])
    def test_drain_multiple_pages(self):
        for count in [0, 51, 101, 512]:
            self.assertEqual(len(poll(Inbox(count))), count)
    def test_partial_failure_and_bad_cursor_publish_nothing(self):
        for invalid in [0, True, '50', -1]:
            class Broken:
                def call_tool(self, name, args):
                    return {'messages':[{'message_id':'m'}], 'next_cursor': invalid}
            out=io.StringIO()
            with contextlib.redirect_stdout(out), self.assertRaises(m.McpError):
                m.cmd_poll(Broken(), SimpleNamespace(token='synthetic', limit=0))
            self.assertEqual(out.getvalue(), '')
        class Failed(Inbox):
            def call_tool(self, name, args):
                if args.get('cursor'):
                    raise m.McpError('synthetic page failure')
                return super().call_tool(name,args)
        out=io.StringIO()
        with contextlib.redirect_stdout(out), self.assertRaises(m.McpError):
            m.cmd_poll(Failed(101),SimpleNamespace(token='synthetic',limit=0))
        self.assertEqual(out.getvalue(),'')
    def test_explicit_send_key_is_preserved_on_retries(self):
        class Uncertain(Inbox):
            def call_tool(self, name, args):
                result=super().call_tool(name,args)
                if len(self.calls)==1:
                    raise m.McpError('synthetic timeout after server accepted send')
                return result
        c=Uncertain(0);args=SimpleNamespace(token='synthetic',to='peer',text='hello',request_id='same_send_1',reply_to=None)
        with contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(m.McpError):m.cmd_send(c,args)
            m.cmd_send(c,args)
        self.assertEqual([a['request_id'] for _,a in c.calls], ['same_send_1']*2)
        args.request_id=None
        with self.assertRaises(m.McpError):m.cmd_send(c,args)
        self.assertEqual(len(c.calls),2)

unittest.main()
