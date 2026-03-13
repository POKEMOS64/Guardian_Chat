import sys
import os

# Простейшее приложение без зависимостей
def application(environ, start_response):
    status = '200 OK'
    output = b'Hello! Python is working!'
    
    response_headers = [('Content-type', 'text/plain; charset=utf-8'),
                        ('Content-Length', str(len(output)))]
    start_response(status, response_headers)
    return [output]
