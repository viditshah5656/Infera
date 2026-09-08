from chat import ChatGPT
import requests



headers = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
}

json_data = {
    'text': 'Tell me something about Arijit Singh.',
}

response = requests.post('http://localhost:5000/conversation', headers=headers, json=json_data, stream=True)

if not response.ok:
    print(response.json())
else:
    for line in response.iter_lines(decode_unicode=True):
        if line:  # skip keep-alive newlines
            print(line)




"""
Class usage example:
"""
# gpt = ChatGPT()
# for chunk in gpt.reply_chat('write a brief vuejs tutorial'):
#     print(chunk,end="",flush=True)