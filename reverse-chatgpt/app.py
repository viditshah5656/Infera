
from fastapi import FastAPI,Request,Response
from fastapi.responses import JSONResponse,StreamingResponse
import asyncio
import time
from uuid import uuid4
from chat import ChatGPT
from pydantic import BaseModel
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
import json

app = FastAPI()

# Define input schema
class ChatRequest(BaseModel):
    text: str  # required field

@app.exception_handler(RequestValidationError)
async def custom_request_validation_exception_handler(request: Request, exc: RequestValidationError):
    errors = {}
    for err in exc.errors():
        loc = err["loc"]
        if len(loc) > 1:
            field = loc[1]  # The actual field name
        else:
            field = loc[0]  # e.g. "body"

        errors.setdefault(field, []).append(err["msg"])

    return JSONResponse(
        status_code=422,
        content={"status": False, "errors": errors},
    )


@app.get("/")
def root():
    return {"message": "Welcome to FastAPI!"}

async def chat_stream(text:str="How are you today ?"):

    gpt = ChatGPT()
    for i,chunk in enumerate(gpt.reply_chat(text)):
        yield ChatGPT.clean_output(chunk)
            
   
# ✅ Endpoint
@app.post("/conversation")
async def chat_stream_endpoint(request: ChatRequest):
    return StreamingResponse(chat_stream(request.text), media_type="text/event-stream")
