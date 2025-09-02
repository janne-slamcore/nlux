import { ChatAdapterExtras, StreamingAdapterObserver } from '@nlux/core';
import { NluxError, NluxUsageError } from '@shared/types/error';
import { warn } from '@shared/utils/warn';
import { parseChunk } from '../parser/parseChunk';
import { ChatAdapterOptions } from '../types/adapterOptions';
import { adapterErrorToExceptionId } from '../utils/adapterErrorToExceptionId';
import { LangServeAbstractAdapter } from './adapter';

// Modified from https://developer.mozilla.org/en-US/docs/Web/API/ReadableStreamDefaultReader/read#example_2_-_handling_text_line_by_line
async function* makeTextFileDoubleLineIterator(response) {
    const utf8Decoder = new TextDecoder("utf-8");
    let reader = response.body.getReader();
    let { value: chunk, done: readerDone } = await reader.read();
    chunk = chunk ? utf8Decoder.decode(chunk, { stream: true }) : "";

    let re = /\r?\n\r?\n/g; // Two new-lines as SSE end of event
    let startIndex = 0;

    for (; ;) {
        let result = re.exec(chunk);
        if (!result) {
            if (readerDone) {
                break;
            }
            let remainder = chunk.substr(startIndex);
            ({ value: chunk, done: readerDone } = await reader.read());
            chunk =
                remainder + (chunk ? utf8Decoder.decode(chunk, { stream: true }) : "");
            startIndex = re.lastIndex = 0;
            continue;
        }
        yield chunk.substring(startIndex, result.index);
        startIndex = re.lastIndex;
    }
    if (startIndex < chunk.length) {
        // last line didn't end in a newline char
        yield chunk.substr(startIndex);
    }
}

export class LangServeStreamAdapter<AiMsg> extends LangServeAbstractAdapter<AiMsg> {
    constructor(options: ChatAdapterOptions<AiMsg>) {
        super(options);
    }

    async batchText(message: string, extras: ChatAdapterExtras<AiMsg>): Promise<string | object | undefined> {
        throw new NluxUsageError({
            source: this.constructor.name,
            message: 'Cannot fetch text using the stream adapter!',
        });
    }

    streamText(
        message: string,
        observer: StreamingAdapterObserver<string | object | undefined>,
        extras: ChatAdapterExtras<AiMsg>,
    ): void {
        const body = this.getRequestBody(
            message,
            this.config,
            extras.conversationHistory,
        );

        fetch(this.endpointUrl, {
            method: 'POST',
            headers: {
                ...this.headers,
                'Content-Type': 'application/json',
            },
            body,
        })
            .then(async (response) => {
                if (!response.ok) {
                    throw new NluxError({
                        source: this.constructor.name,
                        message: `LangServe runnable returned status code: ${response.status}`,
                    });
                }

                if (!response.body) {
                    throw new NluxError({
                        source: this.constructor.name,
                        message: `LangServe runnable returned status code: ${response.status}`,
                    });
                }

                // Read a stream of server-sent events
                // and feed them to the observer as they are being generated
                for await (const chunk of makeTextFileDoubleLineIterator(response)) {
                    const chunkContent = parseChunk(chunk);
                    let error = false;
                    if (Array.isArray(chunkContent)) {
                        for (const aiEvent of chunkContent) {
                            if (aiEvent.event === 'data' && aiEvent.data !== undefined) {
                                observer.next(aiEvent.data as string | object | undefined);
                            }

                            if (aiEvent.event === 'end') {
                                observer.complete();
                                error = true;
                                break;
                            }
                            await new Promise(resolve => setTimeout(resolve, 10)); // Wait for async nonsense to finish for event
                        }
                    }

                    if (chunkContent instanceof Error) {
                        warn(chunkContent);
                        observer.error(chunkContent);
                        error = true;
                    }

                    if (error) {
                        break;
                    }
                }
            })
            .catch((error) => {
                warn(error);
                observer.error(new NluxUsageError({
                    source: this.constructor.name,
                    message: error.message,
                    exceptionId: adapterErrorToExceptionId(error) ?? undefined,
                }));
            });
    }
}
