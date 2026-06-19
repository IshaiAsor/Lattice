import { Component, ElementRef, ViewChild, effect, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AiChatMode, ChatSocketService } from './../../services/ai.chat.service';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';

@Component({
  standalone: true,
  selector: 'app-chat.component',
  imports: [CommonModule, FormsModule],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.css',
})

export class ChatComponent {
  dialogRef = inject(MatDialogRef<ChatComponent>);
  data:{chatMode:AiChatMode} = inject(MAT_DIALOG_DATA);
  protected readonly chatService = inject(ChatSocketService);

  @ViewChild('scrollContainer') private scrollContainer!: ElementRef<HTMLDivElement>;

  protected userInput = '';

  constructor() {
    effect(() => {
      // Access the signal to register the dependency
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _ = this.chatService.messages();

      // Schedule scroll adjustment immediately after the DOM renders the changes
      setTimeout(() => this.scrollToBottom(), 0);
    });
  }

  protected handleEnter(event: Event): void {
    event.preventDefault(); // Prevent carriage return in textarea
    this.submitMessage();
  }

  protected submitMessage(): void {
    const text = this.userInput.trim();
    if (!text || this.chatService.isTyping()) return;

    this.userInput = '';
    this.chatService.sendMessage(text, this.data.chatMode);
  }

  private scrollToBottom(): void {
    if (this.scrollContainer) {
      const element = this.scrollContainer.nativeElement;
      element.scrollTop = element.scrollHeight;
    }
  }
}
