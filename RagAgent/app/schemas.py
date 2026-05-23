from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime

class MessageSchema(BaseModel):
    id: str
    role: str
    text: str
    created_at: Optional[datetime] = None

    model_config = {"from_attributes": True}

class DocumentSchema(BaseModel):
    id: str
    filename: str
    created_at: Optional[datetime] = None

    model_config = {"from_attributes": True}

class ChatSchema(BaseModel):
    id: str
    title: str
    created_at: Optional[datetime] = None

    model_config = {"from_attributes": True}

class ChatRequest(BaseModel):
    query: str = Field(..., description="The user's new message.")